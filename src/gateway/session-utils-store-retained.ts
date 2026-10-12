import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { listAgentIds } from "../agents/agent-scope-config.js";
import type { QualifiedSessionEntryAccessTarget } from "../config/sessions/session-accessor.types.js";
import type { SessionActorHotState } from "../config/sessions/session-actor-contract.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntryWorkerRead } from "../config/sessions/session-entry-read-runtime.types.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import type { SessionMember } from "../config/sessions/session-membership-facts.types.js";
import { listSessionMembers } from "../config/sessions/session-sharing-store.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { assertSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import type { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
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

export type GatewaySessionStoreSelection = {
  logicalStorePath: string;
  env: NodeJS.ProcessEnv;
  target: QualifiedSessionEntryAccessTarget;
  source: NonNullable<SessionEntryWorkerRead["preparedSource"]>;
};

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

/** Only a complete direct selection can outlive discovery without absence queries. */
export function captureGatewaySessionStoreSelection(
  inventory: ReturnType<typeof prepareSessionStoreTargetInventory>,
  target: GatewaySessionStoreTargetWithStore,
  requestedKey: string,
): GatewaySessionStoreSelection | undefined {
  const source = target.capturedReadSource;
  const databaseIdentity = source?.databaseIdentity;
  const paths = inventory.paths.get(target.agentId);
  const key = parseAgentSessionKey(target.canonicalKey);
  // This selection has no alternate source or key whose absence needs a later read.
  return source &&
    typeof databaseIdentity === "string" &&
    source.agentId === target.agentId &&
    target.store[target.canonicalKey]?.incognito !== true &&
    target.store[target.canonicalKey] &&
    key &&
    key.rest !== "global" &&
    key.rest !== "unknown" &&
    target.storeKeys.length === 1 &&
    target.storeKeys[0] === target.canonicalKey &&
    listAgentIds(inventory.config).includes(target.agentId) &&
    !inventory.registryDiscovery &&
    paths &&
    paths.configured === paths.default &&
    resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).agentId ===
      target.agentId &&
    inventory.candidates.every(
      (candidate) => !candidate.scope && candidate.physicalPath === source.path,
    )
    ? {
        logicalStorePath: target.storePath,
        env: inventory.env,
        target: {
          keyFormat: "agent-qualified",
          agentId: target.agentId,
          canonicalKey: target.canonicalKey,
          requestedKey,
          storeKey: target.canonicalKey,
          storeKeys: [...target.storeKeys],
          storePath: source.path,
          readSource: { ...source },
        },
        source: {
          ...source,
          databaseIdentity,
          assertCurrent() {
            assertExistingDatabaseIdentity(
              source.path,
              `file:${databaseIdentity}`,
              source.databaseBirthtime,
            );
            for (const candidate of inventory.candidates) {
              assertSessionStoreReadCandidate(candidate.path, inventory.candidates);
            }
          },
        },
      }
    : undefined;
}

/** Re-read one already-qualified durable target without repeating logical discovery. */
export async function withQualifiedGatewaySessionStoreTarget<T>(params: {
  target: QualifiedSessionEntryAccessTarget;
  logicalStorePath: string;
  env?: NodeJS.ProcessEnv;
  includeMembership: boolean;
  preparedSource?: SessionEntryWorkerRead["preparedSource"];
  readOptions?: Pick<
    SessionEntryWorkerRead,
    "projection" | "snapshotFields" | "lifecycleSessionKey"
  >;
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
          preparedSource: params.preparedSource,
          sessionKeys: params.target.storeKeys,
          lifecycleSessionKey: params.target.storeKey,
          projection: "full",
          includeMembers: params.includeMembership,
          includeAuthorization: true,
          ...params.readOptions,
          env: params.env,
        },
      ],
      ([owner]) => {
        const selected = owner!;
        const capturedReadSource =
          selected.result.source ??
          captureGatewaySessionReadSource(selected.database, selected.result.databaseIdentity);
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
            lifecycleTimestamps: selected.result.lifecycleTimestamps,
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
  const memory = getSessionActorStorageBinding({});
  if (memory) {
    const { actor, authority } = memory;
    const { agentId, canonicalKey: sessionKey } = params.identity;
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({
      agentId,
      env: params.env ?? { OPENCLAW_STATE_DIR: path.resolve(memory.path, "../../../..") },
    });
    const captured = captureSessionActorStorageOwner({ agentId, storePath, sessionActor: memory });
    let snapshot: SessionActorHotState | undefined;
    if (actor.target.sessionKey === sessionKey) {
      snapshot = actor.snapshot(authority);
    } else {
      actor.assertReadable();
      snapshot = captured?.owner?.readSession(sessionKey, authority);
    }
    let consuming = true;
    const assertCurrent = () => {
      if (!consuming) {
        throw new Error("Incognito session source is no longer retained");
      }
      actor.assertReadable();
      authority.assertCurrent();
    };
    try {
      const result = params.consume(
        {
          agentId,
          canonicalKey: sessionKey,
          storePath: captured?.path ?? storePath,
          storeKeys: [sessionKey],
          store: snapshot?.entry ? { [sessionKey]: snapshot.entry } : {},
          readSource: { agentId, path: captured?.path ?? storePath },
        },
        params.includeMembership ? new Map([[sessionKey, snapshot?.members ?? []]]) : new Map(),
        assertCurrent,
      );
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Session entry consumers must remain synchronous");
      }
      return result;
    } finally {
      consuming = false;
    }
  }
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
              capturedReadSource: {
                agentId: actor.agentId,
                path: actor.path,
                databaseIdentity: actor.identity.incarnation,
              },
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
