import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type {
  CapturedSessionEntryReadSource,
  QualifiedSessionEntryAccessTarget,
} from "../config/sessions/session-accessor.types.js";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { listSessionMembers } from "../config/sessions/session-sharing-store.js";
import type { SessionMember } from "../config/sessions/session-sharing-store.kernel.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { sessionChangeAffectsStoredRow } from "../sessions/session-row-facts.js";
import { getOpenIncognitoAgentDatabase } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseSyncResource } from "../state/openclaw-agent-db-resources.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { GatewaySessionFactsChangedDuringReadError } from "./session-utils-store-errors.js";
import type { GatewaySessionStoreTargetWithStore } from "./session-utils-store.types.js";

export function captureGatewaySessionReadSource(
  database: { agentId: string; path: string },
  identity: { identity: string; birthtime?: string } | undefined,
): CapturedSessionEntryReadSource | undefined {
  return identity
    ? {
        agentId: database.agentId,
        path: database.path,
        databaseIdentity: identity.identity,
        ...(identity.birthtime ? { databaseBirthtime: identity.birthtime } : {}),
      }
    : undefined;
}

/** Re-read one already-qualified durable target without repeating logical discovery. */
export async function withQualifiedGatewaySessionStoreTarget<T>(params: {
  target: QualifiedSessionEntryAccessTarget;
  logicalStorePath: string;
  env?: NodeJS.ProcessEnv;
  includeMembership: boolean;
  consume: (
    target: GatewaySessionStoreTargetWithStore,
    membership: ReadonlyMap<string, readonly SessionMember[]>,
    assertCurrent: () => void,
  ) => T;
}): Promise<T> {
  let changed = false;
  const stop = sessionChanges.subscribeFacts((change) => {
    if (
      sessionChangeAffectsStoredRow(change, {
        agentId: params.target.agentId,
        sessionKeys: params.target.storeKeys,
      })
    ) {
      changed = true;
    }
  });
  try {
    return await withSessionEntriesFromStoresInWorker(
      [
        {
          agentId: params.target.readSource?.agentId ?? params.target.agentId,
          // Worker admission resolves the physical database from the logical store path.
          // The qualified target retains that selected database separately as readSource.
          storePath: params.logicalStorePath,
          sessionKeys: params.target.storeKeys,
          lifecycleSessionKey: params.target.storeKey,
          projection: "full",
          includeMembers: params.includeMembership,
          includeAuthorization: true,
          env: params.env,
        },
      ],
      ([owner]) => {
        const selected = owner!;
        const capturedReadSource = captureGatewaySessionReadSource(
          selected.database,
          selected.result.databaseIdentity,
        );
        const assertCurrent = () => {
          selected.assertCurrent();
          if (changed) {
            throw new GatewaySessionFactsChangedDuringReadError();
          }
          if (
            params.target.readSource &&
            !isDeepStrictEqual(capturedReadSource, params.target.readSource)
          ) {
            throw new Error("Qualified session source changed during consumption");
          }
        };
        assertCurrent();
        return params.consume(
          {
            agentId: params.target.agentId,
            canonicalKey: params.target.canonicalKey,
            storePath: params.logicalStorePath,
            storeKeys: [...params.target.storeKeys],
            store: Object.fromEntries(
              selected.result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
            ),
            readSource: selected.database,
            ...(capturedReadSource ? { capturedReadSource } : {}),
            capturedReadSources: capturedReadSource ? [capturedReadSource] : [],
          },
          new Map(Object.entries(selected.result.members ?? {})),
          assertCurrent,
        );
      },
    );
  } finally {
    stop();
  }
}

/** Process-held incognito state cannot be reopened by the durable read worker. */
export function withIncognitoGatewaySessionStoreTarget<T>(params: {
  cfg: OpenClawConfig;
  key: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  projection?: "list" | "full";
  includeMembership?: boolean;
  identity: { agentId: string; canonicalKey: string };
  resolve: () => GatewaySessionStoreTargetWithStore;
  consume: (
    target: GatewaySessionStoreTargetWithStore,
    membership: ReadonlyMap<string, readonly SessionMember[]>,
    assertCurrent: () => void,
  ) => T;
}): T {
  let active = true;
  let changed = false;
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({
    agentId: params.identity.agentId,
    env: params.env,
  });
  const database = getOpenIncognitoAgentDatabase(params.identity.agentId, storePath);
  // Keep the process-held handle, not a freshly resolved row on every assertion.
  // Retirement revokes this resource even if an identical replacement is opened.
  const revoke = () => {
    active = false;
  };
  const release = registerOpenClawAgentDatabaseSyncResource({
    agentId: params.identity.agentId,
    path: storePath,
    revoke,
    close: revoke,
  });
  const stop = sessionChanges.subscribeFacts((change) => {
    if (
      sessionChangeAffectsStoredRow(change, {
        agentId: params.identity.agentId,
        sessionKeys: [params.identity.canonicalKey],
        ignoreStoreTopology: true,
      })
    ) {
      changed = true;
    }
  });
  try {
    const target = params.resolve();
    const membership = new Map<string, readonly SessionMember[]>(
      params.includeMembership
        ? target.storeKeys.map((sessionKey) => [
            sessionKey,
            listSessionMembers({
              agentId: target.agentId,
              storePath: target.storePath,
              sessionKey,
            }),
          ])
        : [],
    );
    const assertCurrent = () => {
      if (
        !active ||
        changed ||
        getOpenIncognitoAgentDatabase(params.identity.agentId, storePath) !== database
      ) {
        throw new Error("Incognito session source changed during consumption");
      }
    };
    assertCurrent();
    const result = params.consume(target, membership, assertCurrent);
    if (isPromiseLike(result)) {
      throw new Error("Session entry consumers must remain synchronous");
    }
    return result;
  } finally {
    active = false;
    stop();
    release();
  }
}
