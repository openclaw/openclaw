import path from "node:path";
import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { AgentDatabaseRegistryChange } from "../../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionAccessScope, SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import {
  readRetainedSessionEntryFacts,
  retainSessionEntryReadFacts,
} from "./session-entry-read-facts.js";
import { readAdmittedSessionEntry } from "./session-entry-read-ordered.js";
import { captureSessionEntryReadScope } from "./session-entry-read-request.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionStoreTarget } from "./session-store-target-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Preserve logical lookup and writable open semantics on the canonical file-backed actor. */
export async function readSessionEntryInWorker(
  input: SessionAccessScope,
  assertCallerCurrent: () => void = () => {},
  onRegistryChange?: (change: AgentDatabaseRegistryChange) => void,
  onReadTarget?: (target: SessionEntryTargetPatchScope) => void,
  reader?: SessionEntryCohortReader,
) {
  if (reader) {
    return readAdmittedSessionEntry(reader, input, assertCallerCurrent, onReadTarget);
  }
  const { scope, env } = captureSessionEntryReadScope(input);
  assertCallerCurrent();
  const agentId = scope.agentId
    ? normalizeAgentId(scope.agentId)
    : parseAgentSessionKey(scope.sessionKey)?.agentId;
  let storePath = scope.storePath ? path.resolve(scope.storePath) : undefined;
  const memory = captureMemoryExactSessionReader(input, assertCallerCurrent);
  if (memory) {
    const sessionKey = resolveSqliteSessionKey(scope.sessionKey, memory.agentId);
    const entry = memory.read(sessionKey);
    onReadTarget?.({
      agentId: memory.agentId,
      env,
      storePath: memory.path,
      readSource: memory.source,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    return entry;
  }
  if (!storePath) {
    if (!agentId) {
      throw new Error("Cannot resolve SQLite session scope without an agent id");
    }
    storePath = resolveOpenClawAgentSqlitePath({ agentId, env });
  }
  const candidates = captureSessionStoreReadCandidates(storePath);
  const loadedRead = await withSessionStoreTarget(
    { agentId, defaultAgentId: scope.defaultAgentId, storePath, env, candidates },
    async (target, owner) => {
      const sessionKey = resolveSqliteSessionKey(scope.sessionKey, target.logicalAgentId);
      const options = { ...target.database, env };
      const targetIdentity = readDatabasePathIdentitySync(options.path);
      const execution = captureOpenClawAgentDatabaseExecution(
        options,
        targetIdentity.key.startsWith("file:")
          ? {
              expectedIdentity: {
                kind: "file",
                physicalIdentity: targetIdentity.key.slice("file:".length),
                nativeLocation: targetIdentity.canonicalPath,
                birthtime: targetIdentity.birthtime,
              },
            }
          : { expectedCreationIdentity: targetIdentity },
      );
      const assertCurrent = () => {
        execution.assertCurrent();
        owner.assertCurrent();
      };
      const source = {
        assertCurrent,
        onRegistryChange(change) {
          owner.onRegistryChange(change);
          onRegistryChange?.(change);
        },
        createAdmission(binding) {
          return () => ({
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              binding.authorize(request);
              assertCurrent();
              if (!grant()) {
                throw new Error("Session read authority expired");
              }
            }, binding.attachment),
          });
        },
      } satisfies AgentDatabaseRequestExecutionSource;
      let entry: SessionEntry | undefined;
      let readTarget: SessionEntryTargetPatchScope | undefined;
      try {
        entry = await runOpenClawAgentWorkerWrite(options, async () => {
          await owner.refreshBeforeDispatch(() => execution.assertCurrent());
          execution.assertCurrent();
          await execution.prepare(source);
          assertCurrent();
          const nativeOwner = execution.captureGenerationClaim();
          const request = { sessionKeys: [sessionKey] };
          const before = readSqliteDatabaseWriteTokenForPath(options.path);
          const cached = readRetainedSessionEntryFacts(options, request, nativeOwner);
          const selected =
            cached ??
            (await execution.runExisting(source, (worker) =>
              worker.execute({ type: "session.entry.read", input: request }),
            ));
          assertCurrent();
          nativeOwner.assertCurrent();
          if (!cached && selected) {
            retainSessionEntryReadFacts(options, request, selected, before);
          }
          return selected?.entries.find((row) => row.sessionKey === sessionKey)?.entry;
        });
        await owner.revalidateTarget();
        assertCurrent();
        if (onReadTarget) {
          const identity = execution.fileIdentity;
          if (!identity) {
            throw new Error("Session entry read omitted its admitted database identity");
          }
          readTarget = {
            agentId: target.logicalAgentId,
            env,
            storePath: options.path,
            readSource: {
              agentId: execution.agentId,
              path: options.path,
              databaseIdentity: identity.physicalIdentity,
              databaseBirthtime: identity.birthtime,
            },
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          };
        }
      } finally {
        await execution.release();
      }
      owner.assertCurrent();
      return { entry, readTarget, assertCurrent: owner.assertCurrent };
    },
    assertCallerCurrent,
  );
  loadedRead.assertCurrent();
  if (loadedRead.readTarget) {
    onReadTarget?.(loadedRead.readTarget);
  }
  return loadedRead.entry;
}
