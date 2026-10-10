import path from "node:path";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { AgentDatabaseRegistryChange } from "../../state/openclaw-agent-db-contract.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { loadSessionEntry } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionAccessScope, SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import { readAdmittedSessionEntry } from "./session-entry-read-ordered.js";
import {
  captureSessionEntryReadScope,
  isNativeSessionEntryRead,
} from "./session-entry-read-request.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionEntry,
} from "./session-incognito-binding.js";
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
  const incognito = captureIncognitoSessionBinding(scope);
  if (incognito) {
    const sessionKey = resolveSqliteSessionKey(scope.sessionKey, incognito.actor.agentId);
    const entry = await withIncognitoSessionEntry(
      incognito,
      sessionKey,
      assertCallerCurrent,
      async (current) => current,
    );
    if (onReadTarget) {
      onReadTarget({
        agentId: incognito.actor.agentId,
        env,
        storePath: incognito.actor.path,
        readSource: {
          agentId: incognito.actor.agentId,
          path: incognito.actor.path,
          databaseIdentity: incognito.actor.identity.incarnation,
        },
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
    }
    return entry;
  }
  // Incognito still belongs to its process-held native owner until that owner's complete cutover.
  if (isNativeSessionEntryRead(scope, agentId)) {
    const entry = loadSessionEntry(scope);
    if (onReadTarget) {
      const nativeAgentId = agentId ?? normalizeAgentId(scope.defaultAgentId);
      const sessionKey = resolveSqliteSessionKey(scope.sessionKey, nativeAgentId);
      onReadTarget({
        agentId: nativeAgentId,
        env,
        storePath:
          scope.storePath ??
          resolveIncognitoOpenClawAgentSqlitePath({ agentId: nativeAgentId, env }),
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
    }
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
          const selected = await execution.runExisting(source, (worker) =>
            worker.execute({ type: "session.entry.read", input: { sessionKey } }),
          );
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
