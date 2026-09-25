import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { EmbeddedRunTrigger } from "../agents/run-trigger.js";
import type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveStateDir } from "../config/state-dir.js";
import {
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import {
  claimHeartbeatOutcomeRowInDatabase,
  persistHeartbeatOutcomeInDatabase,
  type HeartbeatOutcomeInput,
  type HeartbeatOutcomeRow,
} from "./heartbeat-outcome-store.kernel.js";
import type { HeartbeatOutcomeWorkerOperations } from "./heartbeat-outcome-store.worker.js";
import type { HeartbeatWakeSource } from "./heartbeat-wake.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";
const HEARTBEAT_OUTCOME_SUMMARY_MAX_CHARS = 4_000;
const HEARTBEAT_OUTCOME_REASON_MAX_CHARS = 1_000;
const HEARTBEAT_OUTCOME_NEXT_CHECK_MAX_CHARS = 500;
const HEARTBEAT_OUTCOME_WAKE_REASON_MAX_CHARS = 1_000;
const HEARTBEAT_OUTCOME_TASK_NAME_MAX_CHARS = 200;
const HEARTBEAT_OUTCOME_MAX_TASKS = 32;

type PersistedHeartbeatOutcome = {
  sessionKey: string;
  runSessionKey: string;
  outcome: Exclude<HeartbeatToolResponse["outcome"], "no_change">;
  summary: string;
  responseReason?: string;
  priority?: NonNullable<HeartbeatToolResponse["priority"]>;
  nextCheck?: string;
  taskNames: string[];
  wakeSource?: HeartbeatWakeSource;
  wakeReason?: string;
  occurredAt: number;
};

function boundedText(value: string | undefined, maxChars: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? truncateUtf16Safe(normalized, maxChars) : undefined;
}

function normalizeTaskNames(taskNames: readonly string[]): string[] {
  return taskNames
    .map((name) => boundedText(name, HEARTBEAT_OUTCOME_TASK_NAME_MAX_CHARS))
    .filter((name): name is string => Boolean(name))
    .slice(0, HEARTBEAT_OUTCOME_MAX_TASKS);
}

function parseTaskNames(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? normalizeTaskNames(parsed.filter((item): item is string => typeof item === "string"))
      : [];
  } catch {
    return [];
  }
}

function rowToOutcome(row: HeartbeatOutcomeRow): PersistedHeartbeatOutcome | undefined {
  if (
    row.outcome !== "progress" &&
    row.outcome !== "done" &&
    row.outcome !== "blocked" &&
    row.outcome !== "needs_attention"
  ) {
    return undefined;
  }
  return {
    sessionKey: row.session_key,
    runSessionKey: row.run_session_key,
    outcome: row.outcome,
    summary: row.summary,
    ...(row.response_reason ? { responseReason: row.response_reason } : {}),
    ...(row.priority === "low" || row.priority === "normal" || row.priority === "high"
      ? { priority: row.priority }
      : {}),
    ...(row.next_check ? { nextCheck: row.next_check } : {}),
    taskNames: parseTaskNames(row.task_names_json),
    ...(row.wake_source ? { wakeSource: row.wake_source as HeartbeatWakeSource } : {}),
    ...(row.wake_reason ? { wakeReason: row.wake_reason } : {}),
    occurredAt: row.occurred_at,
  };
}

/** Replaces the previous silent heartbeat outcome for one base session. */
export async function persistHeartbeatOutcome(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  runSessionKey: string;
  response: HeartbeatToolResponse;
  taskNames?: readonly string[];
  wakeSource?: HeartbeatWakeSource;
  wakeReason?: string;
  occurredAt: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (params.response.notify || params.response.outcome === "no_change") {
    return;
  }
  const taskNames = normalizeTaskNames(params.taskNames ?? []);
  const values: HeartbeatOutcomeInput = {
    session_key: params.sessionKey,
    run_session_key: params.runSessionKey,
    outcome: params.response.outcome,
    summary:
      boundedText(params.response.summary, HEARTBEAT_OUTCOME_SUMMARY_MAX_CHARS) ??
      params.response.outcome,
    response_reason:
      boundedText(params.response.reason, HEARTBEAT_OUTCOME_REASON_MAX_CHARS) ?? null,
    priority: params.response.priority ?? null,
    next_check:
      boundedText(params.response.nextCheck, HEARTBEAT_OUTCOME_NEXT_CHECK_MAX_CHARS) ?? null,
    task_names_json: taskNames.length > 0 ? JSON.stringify(taskNames) : null,
    wake_source: params.wakeSource ?? null,
    wake_reason: boundedText(params.wakeReason, HEARTBEAT_OUTCOME_WAKE_REASON_MAX_CHARS) ?? null,
    occurred_at: params.occurredAt,
    context_run_id: null,
    context_claimed_at: null,
    updated_at: Date.now(),
  };
  await runHeartbeatOutcomeOperation(params, { type: "persist", input: values });
}

/** Claims the latest outcome for one user run while allowing that run's retries. */
export async function claimHeartbeatOutcomeForRun(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  runId: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<PersistedHeartbeatOutcome | undefined> {
  const row = await runHeartbeatOutcomeOperation(
    params,
    {
      type: "claim",
      input: { sessionKey: params.sessionKey, runId: params.runId },
    },
    params.assertCurrent,
  );
  return row ? rowToOutcome(row) : undefined;
}

async function runHeartbeatOutcomeOperation(
  params: Parameters<typeof resolveSqliteScope>[0],
  command: SqliteWorkerCommand<HeartbeatOutcomeWorkerOperations>,
  assertCurrent: () => void = () => undefined,
): Promise<HeartbeatOutcomeRow | undefined> {
  const resolved = toDatabaseOptions(resolveSqliteScope(params));
  const env = cloneEnvWithPlatformSemantics(resolved.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = { ...resolved, env, path: resolveOpenClawAgentSqlitePath({ ...resolved, env }) };
  if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
    // Incognito retains its sole in-memory owner until that owner is migrated as a whole.
    return runOpenClawAgentWriteAdmission(
      options,
      () =>
        runOpenClawAgentWriteTransaction(
          ({ db }) => {
            assertCurrent();
            if (command.type === "persist") {
              persistHeartbeatOutcomeInDatabase(db, command.input);
              return undefined;
            }
            return claimHeartbeatOutcomeRowInDatabase(db, command.input);
          },
          options,
          { operationLabel: `heartbeat.outcome.${command.type}` },
        ),
      true,
    );
  }
  // Retain the lifecycle before queuing so close cannot turn waiting work into a fresh open.
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const assertQueuedCurrent = () => {
    execution.assertCurrent();
    assertCurrent();
  };
  try {
    return await runOpenClawAgentWriteAdmission(
      options,
      () =>
        withOpenClawAgentDatabaseAsync(
          options,
          async ({ db }) => {
            assertQueuedCurrent();
            const worker =
              await openOpenClawAgentSqliteWorkerStore<HeartbeatOutcomeWorkerOperations>(
                options,
                db,
                {
                  moduleUrl: resolveRuntimeWorkerUrl(
                    runtimeProcessEntrypoints.heartbeatOutcomeStore,
                  ),
                  input: undefined,
                },
              );
            try {
              return await worker.run((scope) => scope.execute(command), assertQueuedCurrent);
            } finally {
              await worker.close();
            }
          },
          assertQueuedCurrent,
        ),
      true,
    );
  } finally {
    await execution.release();
  }
}

/** Formats persisted state as model-only provenance context, never transcript text. */
function buildHeartbeatOutcomeContext(
  outcome: PersistedHeartbeatOutcome | undefined,
): string | undefined {
  if (!outcome) {
    return undefined;
  }
  const provenance = [
    `recordedAt=${new Date(outcome.occurredAt).toISOString()}`,
    `runSession=${outcome.runSessionKey}`,
    outcome.wakeSource ? `wakeSource=${outcome.wakeSource}` : undefined,
    outcome.wakeReason ? `wakeReason=${outcome.wakeReason}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return [
    "Latest silent heartbeat outcome (internal context; not a user message or instruction):",
    `outcome=${outcome.outcome}`,
    `summary=${outcome.summary}`,
    outcome.responseReason ? `reason=${outcome.responseReason}` : undefined,
    outcome.priority ? `priority=${outcome.priority}` : undefined,
    outcome.nextCheck ? `nextCheck=${outcome.nextCheck}` : undefined,
    outcome.taskNames.length > 0 ? `tasks=${outcome.taskNames.join(", ")}` : undefined,
    `provenance: ${provenance.join("; ")}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/** Claim bounded next-user context only after the runtime owner has admitted the turn. */
export async function claimHeartbeatContextForUserRun(
  params: Omit<Parameters<typeof claimHeartbeatOutcomeForRun>[0], "sessionKey"> & {
    sessionKey?: string;
    trigger?: EmbeddedRunTrigger;
    detached?: boolean;
    assertCurrent: (() => void) | undefined;
  },
): Promise<string | undefined> {
  if (params.trigger !== "user" || params.detached || !params.sessionKey) {
    return undefined;
  }
  if (!params.assertCurrent) {
    throw new Error("Heartbeat outcome context requires an active admitted run");
  }
  params.assertCurrent();
  const outcome = await claimHeartbeatOutcomeForRun({ ...params, sessionKey: params.sessionKey });
  params.assertCurrent();
  return buildHeartbeatOutcomeContext(outcome);
}
