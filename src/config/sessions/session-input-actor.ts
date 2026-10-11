import { AsyncLocalStorage } from "node:async_hooks";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureSessionPendingInputWorkerCustody } from "./session-accessor.sqlite-pending-inputs.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import type {
  SessionActor,
  SessionActorAuthority,
  SessionActorLifetime,
} from "./session-actor-contract.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";

export type SessionInputActorBinding = {
  phase: "acceptInput" | "adoptRun";
  acquire(): Promise<{ actor: SessionActor; target: SessionEntryTargetPatchScope } | undefined>;
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
  requestedTarget: SessionEntryTargetPatchScope,
  lifetime: SessionActorLifetime,
): Promise<{ actor: SessionActor; target: SessionEntryTargetPatchScope } | undefined> {
  const agentId = requestedTarget.readSource?.agentId ?? requestedTarget.agentId;
  if (!agentId) {
    throw new Error("Input actor requires its captured agent owner");
  }
  // Sentinel aliases retain their selected physical key (global/unknown).
  const sessionKey = resolveSqliteSessionKey(
    requestedTarget.target.storeKeys[0] ?? requestedTarget.target.canonicalKey,
    agentId,
  );
  const target = {
    ...requestedTarget,
    target: { ...requestedTarget.target, canonicalKey: sessionKey },
  };
  const database = {
    agentId,
    path: target.readSource?.path ?? target.storePath,
    env: target.env,
  };
  lifetime.assertCurrent();
  const { createSessionActorFactory } = await import("./session-actor-durable.js");
  lifetime.assertCurrent();
  const bound = captureIncognitoSessionOperation({
    ...database,
    storePath: database.path,
    sessionKey,
  });
  if (
    bound ||
    isIncognitoSessionKey(sessionKey) ||
    isIncognitoOpenClawAgentSqlitePath(database.path, database)
  ) {
    const actor = await createSessionActorFactory(database).acquire(
      bound
        ? { database: bound.actor.identity, sessionKey }
        : { database: { kind: "native-incognito" }, sessionKey },
      lifetime,
    );
    if ("kind" in actor) {
      return undefined;
    }
    const readSource =
      target.readSource ??
      (bound && {
        agentId,
        path: database.path,
        databaseIdentity: bound.actor.identity.incarnation,
      });
    return { actor, target: { ...target, readSource } };
  }
  if (typeof target.readSource?.databaseIdentity === "symbol") {
    throw new Error("Input actor lost its original native owner");
  }
  return withSessionEntryWorker(
    database,
    target.readSource?.databaseIdentity,
    () => lifetime.assertCurrent(),
    async (execution, source) => {
      await execution.prepare(source);
      const identity = execution.fileIdentity;
      if (!identity) {
        throw new Error("Input actor has no admitted physical database");
      }
      const actor = await createSessionActorFactory(database).acquire(
        { database: identity, sessionKey },
        lifetime,
      );
      if ("kind" in actor) {
        return undefined;
      }
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
  if (!acquired) {
    return undefined;
  }
  if (
    acquired.target.target.canonicalKey !== resolveSqliteSessionKey(scope.sessionKey, scope.agentId)
  ) {
    throw new Error("Input actor differs from the recorder's admitted target");
  }
  const custody = captureSessionPendingInputWorkerCustody();
  return {
    ...acquired,
    phase: binding.phase,
    snapshot(authority: SessionActorAuthority) {
      try {
        return acquired.actor.snapshot(authority);
      } catch (error) {
        // A closed input actor must remain a custody refusal, not enable fallback.
        if (custody) {
          throw new SessionPendingInputCustodyError("Pending input actor is unavailable", {
            cause: error,
          });
        }
        throw error;
      }
    },
  };
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
  if (authorityFailure !== undefined) {
    throw toErrorObject(authorityFailure, "Input actor authority rejected the operation");
  }
  throw Object.assign(new Error(outcome.error.message), { name: outcome.error.name });
}
