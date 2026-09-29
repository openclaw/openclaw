import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptWriterFence,
} from "../config/sessions/transcript-write-context.js";
import { resolveStateDir } from "../config/state-dir.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getOpenIncognitoAgentDatabase,
  retainAgentDatabase,
} from "../state/openclaw-agent-db-lifecycle.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import type {
  SteeredUserTurnTranscriptCommit,
  SteeredUserTurnTranscriptInput,
  SteeredUserTurnTranscriptOperations,
} from "./user-turn-transcript-steering.types.js";
import { normalizePersistedSteerTargetRunId } from "./user-turn-transcript.metadata.js";

export type {
  SteeredUserTurnTranscriptCommit,
  SteeredUserTurnTranscriptSnapshot,
} from "./user-turn-transcript-steering.types.js";

const log = createSubsystemLogger("sessions/steering");

/** Confirm one exact private B snapshot, carrying only an unchanged, current A receipt. */
export async function confirmSteeredUserTurnTranscript(
  params: SteeredUserTurnTranscriptInput & {
    assertCurrent: () => void;
    signal?: AbortSignal;
    /** Synchronous receipt installation, after commit and before releasing the writer. */
    onCommitted?: (result: SteeredUserTurnTranscriptCommit) => void;
  },
): Promise<SteeredUserTurnTranscriptCommit> {
  const { assertCurrent: assertSource, signal, onCommitted } = params;
  const input = structuredClone({
    source: params.source,
    continuation: params.continuation,
    targetRunId: params.targetRunId,
    target: params.target,
  });
  const anchor = input.source.admission;
  if (normalizePersistedSteerTargetRunId(input.targetRunId) !== input.targetRunId) {
    throw new Error("Steer confirmation requires an exact target run id");
  }
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  // Admission receipts name their actual database, not a discoverable session-store alias.
  const options = { agentId: anchor.agentId, path: anchor.storePath, env };
  const logicalTarget = { ...(input.target ?? anchor), env };
  const owned = captureOwnedTranscriptWriteAssertion(logicalTarget);
  const inherited = getOwnedSessionTranscriptWriterFence({ sessionTarget: logicalTarget });
  if (inherited && !input.target) {
    input.target = { ...anchor, ...inherited };
  }
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertSource();
    owned();
  };
  assertCurrent();
  if (input.target) {
    const target = input.target;
    if (
      target.agentId !== anchor.agentId ||
      target.sessionId !== anchor.sessionId ||
      target.sessionKey !== anchor.sessionKey ||
      target.expectedWriterRunId !== input.targetRunId ||
      (inherited &&
        (target.expectedWriterRunId !== inherited.expectedWriterRunId ||
          target.expectedLifecycleRevision !== inherited.expectedLifecycleRevision))
    ) {
      throw new Error("Steer confirmation belongs to another writer target");
    }
  }

  if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
    // This is the retained process-held owner, not a fallback after a durable-worker failure.
    // Its complete migration cannot be accomplished by reopening its sentinel in another isolate.
    const database = getOpenIncognitoAgentDatabase(options.agentId, options.path);
    if (!database) {
      throw new Error("Steer confirmation lost its process-held database");
    }
    const release = retainAgentDatabase(database.db);
    const assertHeld = () => {
      assertCurrent();
      if (getOpenIncognitoAgentDatabase(options.agentId, options.path) !== database) {
        throw new Error("Steer confirmation changed its process-held database");
      }
    };
    try {
      return await runOpenClawAgentWriteAdmission(
        options,
        async () => {
          assertHeld();
          const { confirmSteeredUserTurnTranscriptInTransaction } =
            await import("./user-turn-transcript-steering.worker.js");
          const { runOpenClawAgentWriteTransaction } =
            await import("../state/openclaw-agent-db.js");
          assertHeld();
          if (input.target && path.resolve(input.target.storePath) !== database.path) {
            throw new Error("Steer confirmation belongs to another memory target");
          }
          const result = runOpenClawAgentWriteTransaction(
            (current) => {
              assertHeld();
              if (current.db !== database.db) {
                throw new Error("Steer confirmation changed its process-held database");
              }
              const committed = confirmSteeredUserTurnTranscriptInTransaction(database, input);
              assertHeld();
              return committed;
            },
            options,
            { operationLabel: "session.transcript.message-rewrite" },
          );
          onCommitted?.(result);
          return result;
        },
        true,
        undefined,
        signal,
      );
    } finally {
      release();
    }
  }

  // Capture database identity/lifecycle before alias preparation or FIFO admission can wait.
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const assertHeld = () => {
    execution.assertCurrent();
    assertCurrent();
  };
  try {
    if (input.target) {
      const target = await prepareSqliteTargetFromSessionStorePath(
        input.target.storePath,
        options,
        signal,
      );
      assertHeld();
      if (target.path !== anchor.storePath) {
        throw new Error("Steer confirmation belongs to another database target");
      }
    }
    const worker = await openOpenClawAgentSqliteWorkerStore<SteeredUserTurnTranscriptOperations>(
      options,
      { execution },
      {
        moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.userTurnTranscriptSteering),
        input: { agentId: options.agentId, path: options.path },
      },
    );
    let outcome: Result<SteeredUserTurnTranscriptCommit, unknown>;
    try {
      outcome = ok(
        await worker.run(async (operation) => {
          assertHeld();
          const result = await operation.execute({ type: "confirm", input }, { signal });
          // Still inside the broker's FIFO operation: no awaited cleanup or observer
          // may run between its committed receipt and the recorder's installation.
          onCommitted?.(result);
          return result;
        }, assertHeld),
      );
    } catch (error) {
      outcome = err(error);
    }
    try {
      await worker.close();
    } catch (error) {
      if (!outcome.ok) {
        throw createSqliteLifecycleAggregateError(
          [outcome.error, error],
          "Steer confirmation and cleanup failed",
          outcome.error,
        );
      }
      try {
        log.warn(
          "Steer confirmation committed before cleanup failed: " + formatErrorMessage(error),
        );
      } catch {
        // A diagnostic cannot turn a committed result into a replayable failure.
      }
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    await execution.release();
  }
}
