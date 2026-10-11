import path from "node:path";
import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import type { SessionActor, SessionActorLifetime } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import {
  readRetainedSessionEntryFacts,
  retainSessionEntryReadFacts,
} from "./session-entry-read-facts.js";
import { createAdmittedSessionEntryCohortReader } from "./session-entry-read-ordered.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
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

type ActorSessionAdmissionClaim = {
  kind: "worker" | "memory";
  identity: string;
  incarnation: string;
  readonly target: SessionEntryTargetPatchScope;
  reader?: SessionEntryCohortReader;
  acquireSessionActor(lifetime: SessionActorLifetime): Promise<SessionActor>;
  afterTransition?(
    transition: SessionAdmissionTransition,
    assertOwnerCurrent: () => void,
  ): Promise<ActorSessionAdmissionClaim>;
  isCurrent(): boolean;
  assertCurrent(): void;
  release(): Promise<void>;
};

export type SessionAdmissionDatabaseClaim = OpenClawAgentDatabaseClaim | ActorSessionAdmissionClaim;

/** Admission retains the exact owner that supplied its row across asynchronous policy work. */
export async function loadSessionEntryForAdmission(
  input: SessionAccessScope,
  preparation: {
    signal?: AbortSignal;
    assertCurrent?: () => void;
  } = {},
): Promise<{ entry: SessionEntry | undefined; databaseClaim: SessionAdmissionDatabaseClaim }> {
  const assertCurrent = () => {
    preparation.signal?.throwIfAborted();
    preparation.assertCurrent?.();
  };
  assertCurrent();
  const captured = captureSessionActorStorageOwner(input, {
    assertCurrent,
    authorize: assertCurrent,
  });
  if (captured) {
    // Admission selects a namespace, but does not create a session entry.
    const owner = captured.owner ?? memorySessionActorOwners.get(captured);
    const sessionKey = resolveSqliteSessionKey(input.sessionKey, captured.agentId);
    const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
    env.OPENCLAW_STATE_DIR = path.resolve(captured.path, "../../../..");
    const createClaim = (): ActorSessionAdmissionClaim => {
      let released = false;
      const assertClaimCurrent = () => {
        if (released) {
          throw new Error("Memory session admission claim is released");
        }
        owner.assertCurrent();
      };
      return {
        kind: "memory",
        identity: owner.identity.handle,
        incarnation: owner.identity.incarnation,
        target: {
          agentId: captured.agentId,
          env,
          storePath: captured.path,
          readSource: {
            agentId: captured.agentId,
            path: captured.path,
            databaseIdentity: owner.identity.incarnation,
          },
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        },
        acquireSessionActor(lifetime) {
          assertClaimCurrent();
          return owner.acquire({ database: owner.identity, sessionKey }, lifetime);
        },
        assertCurrent: assertClaimCurrent,
        isCurrent() {
          try {
            assertClaimCurrent();
            return true;
          } catch {
            return false;
          }
        },
        async release() {
          released = true;
        },
        async afterTransition(_transition, assertOwnerCurrent) {
          assertClaimCurrent();
          assertOwnerCurrent();
          return createClaim();
        },
      };
    };
    return {
      entry: owner.readSession(sessionKey, captured.authority)?.entry,
      databaseClaim: createClaim(),
    };
  }
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const scope = { ...input, env };
  const agentId = scope.agentId
    ? normalizeAgentId(scope.agentId)
    : parseAgentSessionKey(scope.sessionKey)?.agentId;
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
  let claim: ActorSessionAdmissionClaim | undefined;
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
              assertSourceCurrent();
              const nativeOwner = execution.captureGenerationClaim();
              const request = { sessionKeys: [sessionKey] };
              const before = readSqliteDatabaseWriteTokenForPath(options.path);
              const cached = readRetainedSessionEntryFacts(options, request, nativeOwner);
              const initial =
                cached ??
                (await execution.runExisting(source, (worker) =>
                  worker.execute(
                    {
                      type: "session.entry.read",
                      input: request,
                    },
                    { signal: preparation.signal },
                  ),
                ));
              await owner.revalidateTarget();
              assertSourceCurrent();
              nativeOwner.assertCurrent();
              if (!initial) {
                throw new Error("Session admission lost its selected database");
              }
              if (!cached) {
                retainSessionEntryReadFacts(options, request, initial, before);
              }
              const entry = initial.entries.find((row) => row.sessionKey === sessionKey)?.entry;
              const nativeIncarnation = nativeOwner.incarnation;
              const createClaim = (
                borrowed: OpenClawAgentDatabaseExecution,
                admittedEntry: SessionAdmissionEntryIdentity | undefined,
              ): ActorSessionAdmissionClaim => {
                const generation = borrowed.captureGenerationClaim();
                const identity = borrowed.fileIdentity;
                if (!identity) {
                  throw new Error("Session admission requires its captured physical identity");
                }
                const admitted = admittedEntry && {
                  sessionId: admittedEntry.sessionId,
                  lifecycleRevision: admittedEntry.lifecycleRevision,
                };
                return {
                  kind: "worker",
                  identity: generation.identity,
                  incarnation: generation.incarnation,
                  target: {
                    agentId: target.logicalAgentId,
                    env,
                    storePath: options.path,
                    readSource: {
                      agentId: borrowed.agentId,
                      path: options.path,
                      databaseIdentity: identity.physicalIdentity,
                      databaseBirthtime: identity.birthtime,
                    },
                    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
                  },
                  async acquireSessionActor(lifetime) {
                    borrowed.assertCurrent();
                    generation.assertCurrent();
                    lifetime.assertCurrent();
                    const { captureDurableSessionActor } =
                      await import("./session-actor-durable.js");
                    borrowed.assertCurrent();
                    generation.assertCurrent();
                    lifetime.assertCurrent();
                    return captureDurableSessionActor({
                      database: { ...options, path: borrowed.path },
                      target: { database: identity, sessionKey },
                      lifetime,
                    });
                  },
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
