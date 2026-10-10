import {
  assertExistingDatabaseIdentity,
  type DatabaseFileIdentity,
} from "../../infra/sqlite-worker-identity.js";
import {
  createOpenClawAgentDatabaseClaim,
  readOpenClawAgentDatabaseIdentity,
  type OpenClawAgentDatabaseClaim,
} from "../../state/openclaw-agent-db-identity.js";
import { readOpenClawAgentDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  borrowOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
} from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionCleanupReadResult } from "./cleanup-service-read.types.js";
import type { ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import { captureSessionStoreCandidateIdentities } from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";
import type { SessionStoreTarget } from "./targets.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export type SessionCleanupSource = {
  database: { agentId: string; path: string; env: NodeJS.ProcessEnv };
  identity?: DatabaseFileIdentity;
  nativeIncarnation?: string;
};

type SessionCleanupStoreOwner = {
  source: SessionCleanupSource;
  resolved: ResolvedSqliteScope & { env: NodeJS.ProcessEnv; path: string };
  assertCurrent: () => void;
  read: (fixMissing?: boolean) => Promise<SessionCleanupReadResult>;
};
type SessionCleanupStoreOptions = { source?: SessionCleanupSource; assertCurrent?: () => void };

/** Retain the preview's physical owner through fresh classification and lifecycle settlement. */
export function withSessionCleanupStore<T>(
  target: SessionStoreTarget,
  consume: (owner: SessionCleanupStoreOwner) => Promise<T>,
  options: SessionCleanupStoreOptions = {},
): Promise<T> {
  const env = captureSessionTranscriptStorageEnvironment(
    options.source?.database.env ?? process.env,
  );
  const path = resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).path;
  if (isIncognitoOpenClawAgentSqlitePath(path, { agentId: target.agentId, env })) {
    return withNativeSessionCleanupStore(
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
      const source = { database, identity };
      const assertCurrent = () => {
        assertReader();
        options.assertCurrent?.();
        if (
          options.source &&
          (database.path !== options.source.database.path ||
            database.agentId !== options.source.database.agentId)
        ) {
          throw new Error("Session cleanup changed its physical store");
        }
        for (const expected of [options.source?.identity, identity]) {
          if (expected) {
            assertExistingDatabaseIdentity(database.path, expected.key, expected.birthtime);
          }
        }
      };
      assertCurrent();
      const result = await consume({
        source,
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
            source.identity = identity;
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

/** An explicit process-held selector keeps the same kernel on its original native owner. */
async function withNativeSessionCleanupStore<T>(
  target: SessionStoreTarget,
  database: SessionCleanupSource["database"],
  consume: (owner: SessionCleanupStoreOwner) => Promise<T>,
  options: SessionCleanupStoreOptions,
): Promise<T> {
  const source: SessionCleanupSource = {
    database,
    nativeIncarnation: options.source?.nativeIncarnation,
  };
  const native: { claim?: OpenClawAgentDatabaseClaim } = {};
  const assertCurrent = () => {
    options.assertCurrent?.();
    native.claim?.assertCurrent();
    const current = getOpenClawAgentDatabaseIfOpen(database);
    if (
      source.nativeIncarnation &&
      (!current ||
        readOpenClawAgentDatabaseIdentity(current).incarnation !== source.nativeIncarnation)
    ) {
      throw new Error("Session cleanup changed its process-held owner");
    }
    if (current && !native.claim) {
      const borrowed = borrowOpenClawAgentDatabase(database);
      native.claim = createOpenClawAgentDatabaseClaim(current, borrowed.release);
      source.nativeIncarnation = readOpenClawAgentDatabaseIdentity(current).incarnation;
    }
    return current;
  };
  try {
    assertCurrent();
    const { readSessionCleanupSnapshotInDatabase } =
      await import("./cleanup-service-read.kernel.js");
    assertCurrent();
    const result = await consume({
      source,
      resolved: { ...database, sessionKey: "", ownerStorePath: target.storePath },
      assertCurrent,
      read: async (fixMissing = false) => {
        const current = assertCurrent();
        if (!current) {
          return { kind: "session-cleanup", store: {}, missing: [] };
        }
        // The retained native claim is the owner; do not resolve or borrow the locator again.
        const read = readOpenClawAgentDatabase(current, (held) =>
          readSessionCleanupSnapshotInDatabase(held, { env: database.env, fixMissing }),
        );
        assertCurrent();
        return read.value;
      },
    });
    assertCurrent();
    return result;
  } finally {
    native.claim?.release();
  }
}
