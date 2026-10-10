import { AsyncLocalStorage } from "node:async_hooks";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import type { SessionActor, SessionActorLifetime } from "./session-actor-contract.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";

export type SessionInputActorBinding = {
  phase: "acceptInput" | "adoptRun";
  acquire(): Promise<{ actor: SessionActor; target: SessionEntryTargetPatchScope }>;
};

const recorderBindings = new WeakMap<
  UserTurnTranscriptRecorder,
  (binding: SessionInputActorBinding) => void
>();

export function registerUserTurnInputActor(
  recorder: UserTurnTranscriptRecorder,
  bind: (binding: SessionInputActorBinding) => void,
): void {
  recorderBindings.set(recorder, bind);
}

/** Internal handoff only: the released recorder shape does not grant actor authority. */
export function bindUserTurnInputActor(
  recorder: UserTurnTranscriptRecorder,
  binding: SessionInputActorBinding,
): void {
  const bind = recorderBindings.get(recorder);
  if (!bind) {
    throw new Error("Input actor requires a factory-owned transcript recorder");
  }
  bind(binding);
}

/** Acquire through the selected writer; never redirect an incognito target to a file. */
export async function acquireSessionInputActor(
  target: SessionEntryTargetPatchScope,
  lifetime: SessionActorLifetime,
): Promise<{ actor: SessionActor; target: SessionEntryTargetPatchScope }> {
  const agentId = target.readSource?.agentId ?? target.agentId;
  if (!agentId) throw new Error("Input actor requires its captured agent owner");
  // Sentinel aliases retain their selected physical key (global/unknown).
  const sessionKey = resolveSqliteSessionKey(
    target.target.storeKeys[0] ?? target.target.canonicalKey,
    agentId,
  );
  target = { ...target, target: { ...target.target, canonicalKey: sessionKey } };
  const database = {
    agentId,
    path: target.readSource?.path ?? target.storePath,
    env: target.env,
  };
  lifetime.assertCurrent();
  const [{ createSessionActorFactory }, { captureNativeIncognitoSessionActorTarget }] =
    await Promise.all([
      import("./session-actor-durable.js"),
      import("./session-actor-native-incognito.js"),
    ]);
  lifetime.assertCurrent();
  const bound = captureIncognitoSessionOperation({
    ...database,
    storePath: database.path,
    sessionKey,
  });
  const native = captureNativeIncognitoSessionActorTarget({ database, sessionKey });
  if (bound || native) {
    const actor = await createSessionActorFactory(database).acquire(
      bound ? { database: bound.actor.identity, sessionKey } : native!,
      lifetime,
    );
    let readSource = target.readSource;
    if (!readSource) {
      const owner = bound ? undefined : getOpenClawAgentDatabaseIfOpen(database);
      if (!bound && !owner) {
        await actor.release();
        throw new Error("Input actor lost its native source before publication");
      }
      readSource = {
        agentId,
        path: database.path,
        databaseIdentity: bound
          ? bound.actor.identity.incarnation
          : readOpenClawAgentDatabaseIdentity(owner!).identity,
      };
    }
    return { actor, target: { ...target, readSource } };
  }
  if (isIncognitoSessionKey(sessionKey)) {
    throw new Error("Input actor lost its incognito database owner");
  }
  if (typeof target.readSource?.databaseIdentity === "symbol") {
    throw new Error("Input actor lost its original native owner");
  }
  return withSessionEntryWorker(
    database,
    target.readSource?.databaseIdentity,
    lifetime.assertCurrent,
    async (execution, source) => {
      await execution.prepare(source);
      const identity = execution.fileIdentity;
      if (!identity) throw new Error("Input actor has no admitted physical database");
      const actor = await createSessionActorFactory(database).acquire(
        { database: identity, sessionKey },
        lifetime,
      );
      return {
        actor,
        target: {
          ...target,
          readSource: target.readSource ?? {
            agentId: database.agentId,
            path: database.path,
            databaseIdentity: identity.physicalIdentity,
            databaseBirthtime: identity.birthtime,
          },
        },
      };
    },
  );
}

const inputActor = new AsyncLocalStorage<SessionInputActorBinding | undefined>();

export function hasSessionInputActor(): boolean {
  return inputActor.getStore() !== undefined;
}

/** Recorder calls capture their binding before yielding; handoff never redirects accepted work. */
export function withSessionInputActor<T>(
  binding: SessionInputActorBinding | undefined,
  run: () => T,
): T {
  return inputActor.run(binding, run);
}

export async function getSessionInputActor(scope: { agentId: string; sessionKey: string }) {
  const binding = inputActor.getStore();
  if (!binding) {
    return undefined;
  }
  const acquired = await binding.acquire();
  if (
    acquired.target.target.canonicalKey !== resolveSqliteSessionKey(scope.sessionKey, scope.agentId)
  ) {
    throw new Error("Input actor differs from the recorder's admitted target");
  }
  return { ...acquired, phase: binding.phase };
}

export function throwSessionInputActorFailure(
  outcome: {
    kind: "rolled-back" | "stale-version" | "unknown";
    error: { name: string; message: string };
  },
  authorityFailure?: unknown,
): never {
  if (outcome.kind === "unknown") {
    throw new SqliteWorkerError(outcome.error.message, "outcome-unknown");
  }
  if (authorityFailure !== undefined) throw authorityFailure;
  throw Object.assign(new Error(outcome.error.message), { name: outcome.error.name });
}
