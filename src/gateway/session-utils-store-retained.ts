import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { QualifiedSessionEntryAccessTarget } from "../config/sessions/session-accessor.types.js";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import { listSessionMembers } from "../config/sessions/session-sharing-store.js";
import type { SessionMember } from "../config/sessions/session-sharing-store.kernel.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  prepareSessionRowPublicationScope,
  sessionChangeAffectsStoredRow,
} from "../sessions/session-row-facts.js";
import { findOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
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
  const publication = prepareSessionRowPublicationScope(
    [
      params.logicalStorePath,
      params.target.storePath,
      ...(params.target.readSource ? [params.target.readSource.path] : []),
    ],
    params.target.readSource?.databaseIdentity,
  );
  let changed = false;
  const stop = sessionChanges.subscribeFacts((change) => {
    if (
      sessionChangeAffectsStoredRow(change, {
        ...publication,
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
          if (changed) {
            throw new GatewaySessionFactsChangedDuringReadError();
          }
          selected.assertCurrent();
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
      {
        ordered: true,
        onReadAdmitted: () => {
          // The snapshot includes every write that settled before this FIFO turn.
          changed = false;
        },
        prepareSource: (_input, ...source) => publication.prepareSource(...source),
      },
    );
  } finally {
    stop();
  }
}

/** Process-held incognito state cannot be reopened by the durable read worker. */
export function withIncognitoGatewaySessionStoreTarget<T>(params: {
  env?: NodeJS.ProcessEnv;
  includeMembership?: boolean;
  identity: { agentId: string; canonicalKey: string };
  resolve: () => GatewaySessionStoreTargetWithStore;
  consume: (
    target: GatewaySessionStoreTargetWithStore,
    membership: ReadonlyMap<string, readonly SessionMember[]>,
    assertCurrent: () => void,
  ) => T;
}): T | Promise<T> {
  const binding = captureIncognitoSessionBinding({
    agentId: params.identity.agentId,
    sessionKey: params.identity.canonicalKey,
    env: params.env,
  });
  if (binding) {
    const { actor, admissionSignal } = binding;
    const sessionKey = params.identity.canonicalKey;
    const authority = { assertCurrent: () => admissionSignal?.throwIfAborted() };
    return actor.sessions
      .withSharedState(async () => {
        const read = await actor.sessions.read(authority, { sessionKey });
        const members = params.includeMembership
          ? (
              await actor.sessions.sideData(authority, {
                type: "session.members.read",
                input: { sessionKey },
              })
            ).members
          : [];
        let consuming = true;
        const assertCurrent = () => {
          if (!consuming) {
            throw new Error("Incognito session source is no longer retained");
          }
          authority.assertCurrent();
          actor.assertReadable();
          read.snapshot.assertCurrent();
        };
        try {
          assertCurrent();
          const result = params.consume(
            {
              agentId: actor.agentId,
              canonicalKey: sessionKey,
              storePath: actor.path,
              storeKeys: [sessionKey],
              store: read.entry ? { [sessionKey]: read.entry } : {},
              readSource: { agentId: actor.agentId, path: actor.path },
            },
            params.includeMembership ? new Map([[sessionKey, members]]) : new Map(),
            assertCurrent,
          );
          if (isPromiseLike(result)) {
            void Promise.resolve(result).catch(() => undefined);
            throw new Error("Session entry consumers must remain synchronous");
          }
          assertCurrent();
          return { result, snapshot: read.snapshot };
        } finally {
          consuming = false;
        }
      })
      .then(({ result, snapshot }) => {
        authority.assertCurrent();
        actor.assertReadable();
        snapshot.assertCurrent();
        return result;
      });
  }
  let active = true;
  let changed = false;
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({
    agentId: params.identity.agentId,
    env: params.env,
  });
  const database = getOpenIncognitoAgentDatabase(params.identity.agentId, storePath);
  const publication = prepareSessionRowPublicationScope(
    [storePath],
    database && findOpenClawAgentDatabaseIdentity(database)?.identity,
  );
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
        ...publication,
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
