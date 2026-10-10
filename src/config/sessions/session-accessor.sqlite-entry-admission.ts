import path from "node:path";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  isIncognitoSessionKey,
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { IncognitoSessionEndedError } from "../../state/incognito-session-error.js";
import {
  createOpenClawAgentDatabaseClaim,
  type OpenClawAgentDatabaseClaim,
} from "../../state/openclaw-agent-db-identity.js";
import {
  borrowOpenClawAgentDatabase,
  isIncognitoOpenClawAgentSqlitePath,
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteScope,
  resolveSqliteSessionKey,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { createAdmittedSessionEntryCohortReader } from "./session-entry-read-ordered.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import {
  captureIncognitoSessionBinding,
  captureIncognitoSessionTopology,
} from "./session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionStoreTarget } from "./session-store-target-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionAdmissionEntryIdentity = Readonly<
  Pick<SessionEntry, "sessionId" | "lifecycleRevision">
>;
export type SessionAdmissionTransition = Readonly<{
  previous?: SessionAdmissionEntryIdentity;
  current: SessionAdmissionEntryIdentity;
}>;

type WorkerSessionAdmissionClaim = {
  kind: "worker";
  identity: string;
  incarnation: string;
  reader?: SessionEntryCohortReader;
  afterTransition?(
    transition: SessionAdmissionTransition,
    assertOwnerCurrent: () => void,
  ): Promise<WorkerSessionAdmissionClaim>;
  isCurrent(): boolean;
  assertCurrent(): void;
  release(): Promise<void>;
};

export type SessionAdmissionDatabaseClaim =
  | OpenClawAgentDatabaseClaim
  | WorkerSessionAdmissionClaim;

/** Admission retains the exact owner that supplied its row across asynchronous policy work. */
export async function loadSessionEntryForAdmission(
  input: SessionAccessScope,
  preparation: {
    signal?: AbortSignal;
    assertCurrent?: () => void;
    incognito?: SessionCollaborationScope["incognito"];
  } = {},
): Promise<{ entry: SessionEntry | undefined; databaseClaim: SessionAdmissionDatabaseClaim }> {
  const binding = captureIncognitoSessionBinding(input);
  const env = cloneEnvWithPlatformSemantics(
    input.env ?? (binding && captureIncognitoSessionTopology()?.env) ?? process.env,
  );
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const scope = { ...input, env };
  const agentId = scope.agentId
    ? normalizeAgentId(scope.agentId)
    : parseAgentSessionKey(scope.sessionKey)?.agentId;
  const assertCurrent = () => {
    preparation.signal?.throwIfAborted();
    binding?.admissionSignal?.throwIfAborted();
    preparation.assertCurrent?.();
  };
  assertCurrent();
  const incognitoBinding =
    preparation.incognito ??
    (binding && {
      actor: binding.actor,
      authority: { assertCurrent: () => binding.actor.assertReadable() },
    });
  if (incognitoBinding) {
    const { actor, authority } = incognitoBinding;
    const resolved = resolveSqliteScope(scope);
    const options = toDatabaseOptions(resolved);
    if (actor.agentId !== resolved.agentId || actor.path !== options.path) {
      throw new Error("Admission target differs from its captured incognito actor");
    }
    const current: IncognitoSessionAuthority = {
      assertCurrent() {
        assertCurrent();
        authority.assertCurrent();
        actor.assertCurrent();
      },
      authorize: (stage, facts) => authority.authorize?.(stage, facts),
    };
    current.assertCurrent();
    const borrowed = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: resolved.agentId,
      env,
      // The returned claim retains the physical owner, independently of its caller's admission.
      authority: { assertCurrent: () => actor.assertCurrent() },
      existingOnly: true,
      signal: preparation.signal,
    });
    if (!borrowed) {
      throw new IncognitoSessionEndedError();
    }
    const releaseGate = createDeferredCore();
    let held: Promise<void> | undefined;
    let released = false;
    let releasing: Promise<void> | undefined;
    const assertClaimCurrent = () => {
      if (released) {
        throw new Error("Incognito admission claim is released");
      }
      borrowed.assertCurrent();
    };
    const release = () => {
      released = true;
      releaseGate.resolve();
      return (releasing ??= (async () => {
        // Close may revoke disclosure, but the retained policy lifetime still joins cleanup.
        if (held) {
          await Promise.allSettled([held]);
        }
        await borrowed.release();
      })());
    };
    let transferred = false;
    try {
      current.assertCurrent();
      if (
        borrowed.identity.handle !== actor.identity.handle ||
        borrowed.identity.incarnation !== actor.identity.incarnation
      ) {
        throw new IncognitoSessionEndedError();
      }
      held = borrowed.sessions.withSharedState(() => releaseGate.promise);
      void held.catch(() => undefined);
      const snapshot = await borrowed.sessions.read(
        current,
        { sessionKey: resolved.sessionKey },
        preparation.signal,
      );
      current.assertCurrent();
      snapshot.claim.assertCurrent();
      snapshot.snapshot.assertCurrent();
      const databaseClaim: WorkerSessionAdmissionClaim = {
        kind: "worker",
        identity: borrowed.identity.handle,
        incarnation: borrowed.identity.incarnation,
        assertCurrent: assertClaimCurrent,
        isCurrent() {
          try {
            assertClaimCurrent();
            return true;
          } catch {
            return false;
          }
        },
        release,
      };
      transferred = true;
      return { entry: snapshot.entry, databaseClaim };
    } finally {
      if (!transferred) {
        await release();
      }
    }
  }
  const incognito =
    isIncognitoSessionKey(scope.sessionKey) ||
    Boolean(
      scope.storePath &&
      (isIncognitoOpenClawAgentSqlitePath(scope.storePath, {
        agentId: agentId ?? scope.defaultAgentId ?? LEGACY_IMPLICIT_AGENT_ID,
        env,
      }) ||
        listOpenIncognitoAgentDatabases().some((owner) => owner.storePath === scope.storePath)),
    );
  if (incognito) {
    const resolved = resolveSqliteScope(scope);
    const options = toDatabaseOptions(resolved);
    const database = openOpenClawAgentDatabase(options);
    const borrowed = borrowOpenClawAgentDatabase(options);
    const databaseClaim = createOpenClawAgentDatabaseClaim(database, borrowed.release);
    try {
      assertCurrent();
      return { entry: readSessionEntryRow(database, resolved.sessionKey)?.entry, databaseClaim };
    } catch (error) {
      databaseClaim.release();
      throw error;
    }
  }
  let storePath: string;
  if (scope.storePath) {
    storePath = path.resolve(scope.storePath);
  } else {
    if (!agentId) {
      throw new Error("Cannot resolve SQLite session scope without an agent id");
    }
    storePath = resolveOpenClawAgentSqlitePath({ agentId, env });
  }
  const candidates = captureSessionStoreReadCandidates(storePath);
  let claim: WorkerSessionAdmissionClaim | undefined;
  try {
    const result = await withSessionStoreTarget(
      { agentId, defaultAgentId: scope.defaultAgentId, storePath, env, candidates },
      async (target, owner) => {
        const options = { ...target.database, path: target.sourcePath, env };
        const observed = readDatabasePathIdentitySync(options.path);
        return await runOpenClawAgentWorkerWrite(
          options,
          async () => {
            // Discovery retains the file while queued; an earlier cancelled open may retire its executor.
            const execution = captureOpenClawAgentDatabaseExecution(
              options,
              observed.key.startsWith("file:")
                ? {
                    expectedIdentity: {
                      kind: "file",
                      physicalIdentity: observed.key.slice("file:".length),
                      nativeLocation: observed.canonicalPath,
                      birthtime: observed.birthtime,
                    },
                  }
                : { expectedCreationIdentity: observed },
            );
            const assertSourceCurrent = () => {
              assertCurrent();
              execution.assertCurrent();
              owner.assertCurrent();
            };
            const source: AgentDatabaseRequestExecutionSource = {
              assertCurrent: assertSourceCurrent,
              onRegistryChange: owner.onRegistryChange,
              createAdmission(admissionBinding) {
                return () => ({
                  nativeLocations: admissionBinding.nativeLocations,
                  admission: createSqliteWorkerOperationAdmission((request, grant) => {
                    admissionBinding.authorize(request);
                    assertSourceCurrent();
                    if (!grant()) {
                      throw new Error("Session admission authority expired");
                    }
                  }, admissionBinding.attachment),
                });
              },
            };
            let transferred = false;
            try {
              await owner.refreshBeforeDispatch(() => execution.assertCurrent());
              assertSourceCurrent();
              await execution.prepare(source, preparation.signal);
              const sessionKey = resolveSqliteSessionKey(scope.sessionKey, target.logicalAgentId);
              const initial = await execution.runExisting(source, (worker) =>
                worker.execute(
                  {
                    type: "session.entry.read",
                    input: {
                      sessionKeys: [sessionKey],
                    },
                  },
                  { signal: preparation.signal },
                ),
              );
              await owner.revalidateTarget();
              assertSourceCurrent();
              if (!initial) {
                throw new Error("Session admission lost its selected database");
              }
              const entry = initial.entries.find((row) => row.sessionKey === sessionKey)?.entry;
              const nativeIncarnation = initial.databaseIdentity.incarnation;
              const createClaim = (
                borrowed: OpenClawAgentDatabaseExecution,
                admittedEntry: SessionAdmissionEntryIdentity | undefined,
              ): WorkerSessionAdmissionClaim => {
                const generation = borrowed.captureGenerationClaim();
                const admitted = admittedEntry && {
                  sessionId: admittedEntry.sessionId,
                  lifecycleRevision: admittedEntry.lifecycleRevision,
                };
                return {
                  kind: "worker",
                  identity: generation.identity,
                  incarnation: generation.incarnation,
                  reader: admitted
                    ? createAdmittedSessionEntryCohortReader({
                        execution: borrowed,
                        generation,
                        database: { ...target.database, env },
                        sessionKey,
                        logicalAgentId: target.logicalAgentId,
                        storePaths: [storePath, target.sourcePath],
                        expected: {
                          incarnation: nativeIncarnation,
                          sessions: [{ sessionKey, ...admitted }],
                        },
                      })
                    : undefined,
                  assertCurrent: () => generation.assertCurrent(),
                  isCurrent() {
                    try {
                      generation.assertCurrent();
                      return true;
                    } catch {
                      return false;
                    }
                  },
                  release: () => borrowed.release(),
                  async afterTransition({ previous, current }, assertOwnerCurrent) {
                    generation.assertCurrent();
                    assertOwnerCurrent();
                    if (
                      previous?.sessionId !== admitted?.sessionId ||
                      previous?.lifecycleRevision !== admitted?.lifecycleRevision
                    ) {
                      throw new Error("Session transition changed its admitted predecessor");
                    }
                    const expectedIdentity = borrowed.fileIdentity;
                    if (!expectedIdentity) {
                      throw new Error("Session transition lost its admitted physical identity");
                    }
                    const successor = captureOpenClawAgentDatabaseExecution(
                      { ...options, path: borrowed.path },
                      { expectedIdentity, requestedPath: storePath },
                    );
                    try {
                      // Borrow this prepared generation only; never open a replacement at the path.
                      const next = successor.capturePreparedGenerationClaim();
                      if (
                        !next ||
                        next.identity !== generation.identity ||
                        next.incarnation !== generation.incarnation
                      ) {
                        throw new Error("Session transition changed its native generation");
                      }
                      generation.assertCurrent();
                      assertOwnerCurrent();
                      return createClaim(successor, {
                        sessionId: current.sessionId,
                        lifecycleRevision: current.lifecycleRevision,
                      });
                    } catch (error) {
                      await successor.release();
                      throw error;
                    }
                  },
                };
              };
              claim = createClaim(execution, entry);
              transferred = true;
              return { entry, databaseClaim: claim };
            } finally {
              if (!transferred) {
                await execution.release();
              }
            }
          },
          undefined,
          preparation.signal,
        );
      },
      assertCurrent,
    );
    assertCurrent();
    result.databaseClaim.assertCurrent();
    return result;
  } catch (error) {
    await claim?.release();
    throw error;
  }
}
