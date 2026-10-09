import {
  assertDatabasePathIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmissions } from "../../state/openclaw-agent-write-admission.js";
import type { PhysicalStore } from "./legacy-main-session-migration.contract.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { captureSessionEntryNativeMutationWitness } from "./session-entry-read-ordered.js";
import type {
  SessionRetirementReadOperation,
  SessionRetirementReadResult,
} from "./session-retirement-read.types.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Lists persisted session keys without materializing their entry JSON. */
export async function listSessionEntryKeysReadOnly(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
): Promise<string[]> {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const options = toDatabaseOptions(resolved);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const reader = captureSessionRetirementReader(
    {
      databaseAgentId: resolved.databaseAgentId ?? resolved.agentId,
      ownerStorePath: pathname,
      path: pathname,
    },
    resolved.env ?? process.env,
  );
  return withSessionRetirementReaders([reader], async () => {
    const result = await reader.read({ operation: "keys", ordered: true });
    reader.assertCurrent();
    if (result.operation !== "keys") {
      throw new Error("Session key inventory returned another retirement operation");
    }
    return result.keys;
  });
}

/** Capture physical custody before either scan phase can yield. */
export function captureSessionRetirementReader(
  store: PhysicalStore,
  environment: NodeJS.ProcessEnv,
) {
  const storePath = store.path;
  const identity = readDatabasePathIdentitySync(storePath);
  const ownerStorePath = store.ownerStorePath;
  const ownerIdentity =
    ownerStorePath !== storePath ? readDatabasePathIdentitySync(ownerStorePath) : undefined;
  const env = captureSessionTranscriptStorageEnvironment(environment);
  const database = { agentId: store.databaseAgentId, path: identity.canonicalPath, env };
  const assertCurrent = () => {
    assertDatabasePathIdentity(storePath, identity);
    if (ownerIdentity) {
      assertDatabasePathIdentity(ownerStorePath, ownerIdentity);
    }
  };
  const read = async (
    request: SessionRetirementReadOperation,
  ): Promise<SessionRetirementReadResult> => {
    assertCurrent();
    if (!identity.key.startsWith("file:")) {
      return request.operation === "keys"
        ? { operation: "keys", keys: [] }
        : { operation: "comparison-claims", claims: [] };
    }
    return withSessionHistoryWorkerDatabase(
      database,
      async (reader) => {
        assertCurrent();
        const result = await reader.readRetirement({ env, expectedIdentity: identity, request });
        reader.assertCurrent();
        assertCurrent();
        return result;
      },
      maintenanceLane,
    );
  };
  return { database, assertCurrent, read };
}

/** Hold the existing writer FIFO through asynchronous scans; native SDK writes invalidate the read. */
export function withSessionRetirementReaders<T>(
  readers: readonly ReturnType<typeof captureSessionRetirementReader>[],
  read: () => Promise<T>,
): Promise<T> {
  const databases = readers.map((reader) => reader.database);
  return runOpenClawAgentWriteAdmissions(
    databases,
    async () => {
      const assertNativeCurrent = captureSessionEntryNativeMutationWitness(databases);
      const result = await read();
      assertNativeCurrent();
      return result;
    },
    true,
  );
}
