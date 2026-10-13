import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { SessionWorkStartInvalidatedError } from "./lifecycle.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  acquireSessionActorStorage,
  captureSessionActorStorageOwner,
} from "./session-actor-storage-binding.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import {
  SessionReactionLimitError,
  SessionReactionMessageMissingError,
} from "./session-reaction-errors.js";
import type {
  SessionReactionWrite,
  SetSessionReactionParams,
} from "./session-reaction-store.types.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionStoreTarget } from "./session-store-target-runtime.js";
import { createSessionWorkerExecutionSource } from "./session-worker-execution-source.js";

export { SessionReactionLimitError, SessionReactionMessageMissingError };

function restoreReactionError(error: unknown): never {
  if (error instanceof Error) {
    if (error.name === "SessionReactionLimitError") {
      throw new SessionReactionLimitError();
    }
    if (error.name === "SessionReactionMessageMissingError") {
      throw new SessionReactionMessageMissingError();
    }
    if (error.name === "SessionWorkStartInvalidatedError") {
      throw new SessionWorkStartInvalidatedError(error.message);
    }
  }
  throw error;
}

export async function setSessionReactionAsync(
  scope: SessionCollaborationScope,
  params: SetSessionReactionParams & { assertCurrent?: () => void },
): Promise<SessionReactionWrite> {
  const { assertCurrent = () => undefined, ...reaction } = params;
  const authority = { assertCurrent, authorize: assertCurrent };
  if (captureSessionActorStorageOwner(scope, authority)) {
    const memory = await acquireSessionActorStorage(scope, {
      lifetime: { assertCurrent, assertReadable: assertCurrent },
      authority,
    });
    if (!memory) {
      throw new SessionWorkStartInvalidatedError("session changed before reaction mutation");
    }
    try {
      const outcome = await memory.actor.storage.mutate(
        { type: "session.reaction.set", input: { params: reaction } },
        memory.authority,
      );
      if (outcome.kind === "committed") {
        return outcome.value;
      }
      const error = new Error(outcome.error.message);
      error.name = outcome.error.name;
      return restoreReactionError(error);
    } finally {
      await memory.actor.release();
    }
  }
  assertCurrent();
  const input = structuredClone(reaction);
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  // Resolve the logical key without consulting a custom store's native registry.
  const logical = resolveSqliteScope({ ...scope, storePath: undefined, env });
  const storePath =
    logical.path ?? scope.storePath ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(logical));
  const candidates = captureSessionStoreReadCandidates(storePath);
  try {
    return await withSessionStoreTarget(
      { agentId: logical.agentId, storePath, env, candidates },
      async (selected, owner) => {
        const options = { ...selected.database, env };
        const execution = captureOpenClawAgentDatabaseExecution(options);
        const assertHeld = () => {
          execution.assertCurrent();
          owner.assertCurrent();
        };
        try {
          assertHeld();
          const result = await runOpenClawAgentWorkerWrite(options, () =>
            execution.runExisting(
              createSessionWorkerExecutionSource(assertHeld, "Reaction authority expired"),
              (worker) =>
                worker.execute({
                  type: "session.reaction.set",
                  input: { sessionKey: logical.sessionKey, params: input },
                }),
            ),
          );
          if (!result) {
            throw new SessionWorkStartInvalidatedError("session changed before reaction mutation");
          }
          return result;
        } finally {
          await execution.release();
        }
      },
      assertCurrent,
    );
  } catch (error) {
    return restoreReactionError(error);
  }
}
