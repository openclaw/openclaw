import {
  assertExistingDatabaseIdentity,
  type DatabaseFileIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { shouldPreserveSessionCleanupEntry } from "./cleanup-service-read.policy.js";
import type { SessionCleanupReadResult } from "./cleanup-service-read.types.js";
import type { ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import { captureSessionStoreCandidateIdentities } from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";
import type { SessionStoreTarget } from "./targets.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

type SessionCleanupStoreOwner = {
  resolved: ResolvedSqliteScope & { env: NodeJS.ProcessEnv; path: string };
  assertCurrent: () => void;
  read: (fixMissing?: boolean) => Promise<SessionCleanupReadResult>;
};
type SessionCleanupStoreOptions = { assertCurrent?: () => void };

/** Retain one physical owner through classification and lifecycle settlement. */
export function withSessionCleanupStore<T>(
  target: SessionStoreTarget,
  consume: (owner: SessionCleanupStoreOwner) => Promise<T>,
  options: SessionCleanupStoreOptions = {},
): Promise<T> {
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const path = resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).path;
  if (isIncognitoOpenClawAgentSqlitePath(path, { agentId: target.agentId, env })) {
    return withMemorySessionCleanupStore(
      target,
      { agentId: target.agentId, path, env },
      consume,
      options,
    );
  }
  const identities = captureSessionStoreCandidateIdentities(
    captureSessionStoreReadCandidates(target.storePath),
  );
  let identity: DatabaseFileIdentity | undefined;
  return withSessionStoreReaderInWorker(
    { ...target, env },
    async ({ reader, database, logicalAgentId, continuation, assertCurrent: assertReader }) => {
      const assertCurrent = () => {
        assertReader();
        options.assertCurrent?.();
        if (identity) {
          assertExistingDatabaseIdentity(database.path, identity.key, identity.birthtime);
        }
      };
      assertCurrent();
      const result = await consume({
        resolved: {
          agentId: logicalAgentId,
          databaseAgentId: database.agentId,
          path: database.path,
          env: database.env,
          sessionKey: "",
          ownerStorePath: target.storePath,
        },
        assertCurrent,
        read: async (fixMissing = false) => {
          assertCurrent();
          const snapshot = await reader.readCleanup({
            env: database.env,
            expectedIdentity: identity && { ...identity, canonicalPath: database.path },
            continuation,
            fixMissing,
          });
          if (!identity && snapshot.source) {
            identity = {
              key: `file:${snapshot.source.databaseIdentity}`,
              birthtime: snapshot.source.databaseBirthtime,
            };
          }
          assertCurrent();
          return snapshot;
        },
      });
      assertCurrent();
      return result;
    },
    {
      lane: maintenanceLane,
      logical: { assertCurrent: options.assertCurrent },
      prepareSource: (database, captured) => {
        const original = identities.get(captured.canonicalPath);
        if (captured.key.startsWith("file:")) {
          if (
            !original ||
            original.key !== captured.key ||
            original.birthtime !== captured.birthtime
          ) {
            throw new Error("Session cleanup changed its physical owner during discovery");
          }
          assertExistingDatabaseIdentity(database.path, original.key, original.birthtime);
          identity = original;
        }
      },
    },
  );
}

/** A memory preview retains the same actor namespace through classification and consumption. */
async function withMemorySessionCleanupStore<T>(
  target: SessionStoreTarget,
  database: { agentId: string; path: string; env: NodeJS.ProcessEnv },
  consume: (owner: SessionCleanupStoreOwner) => Promise<T>,
  options: SessionCleanupStoreOptions,
): Promise<T> {
  const assertCaller = () => options.assertCurrent?.();
  const authority = { assertCurrent: assertCaller, authorize: assertCaller };
  const captured = captureSessionActorStorageOwner(
    { ...database, storePath: database.path },
    authority,
  );
  if (!captured) {
    throw new Error("Session cleanup lost its memory owner selector");
  }
  const memory = captured.owner;
  const assertCurrent = () => {
    captured.authority.assertCurrent();
    memory?.assertCurrent();
  };
  return consume({
    resolved: { ...database, sessionKey: "", ownerStorePath: target.storePath },
    assertCurrent,
    read: async (fixMissing = false) => {
      assertCurrent();
      const entries = memory?.listSessionEntries(captured.authority) ?? [];
      const store = Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
      const missing: SessionCleanupReadResult["missing"] = [];
      if (fixMissing && memory) {
        // Synchronous reads share the captured owner's state without interleaved mutations.
        for (const { sessionKey, entry } of entries) {
          if (shouldPreserveSessionCleanupEntry(sessionKey, entry)) {
            continue;
          }
          const hasMessages = memory.readStorage(
            sessionKey,
            { type: "session.history.message-presence", input: { sessionId: entry.sessionId } },
            captured.authority,
          );
          if (hasMessages === false) {
            missing.push({
              sessionKey,
              expectedEntry: entry,
              archiveRemovedTranscript: true,
              requiresMissingTranscript: true,
            });
          }
        }
      }
      return { kind: "session-cleanup", store, missing };
    },
  });
}
