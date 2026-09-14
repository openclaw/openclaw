import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { EmbeddedRunTrigger } from "../agents/embedded-agent-runner/run/params.js";
import type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseExecutionSource } from "../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
} from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import {
  claimHeartbeatOutcomeRowInDatabase,
  persistHeartbeatOutcomeInDatabase,
  type HeartbeatOutcomeInput,
  type HeartbeatOutcomeRow,
} from "./heartbeat-outcome-store.kernel.js";
import type { HeartbeatWakeSource } from "./heartbeat-wake.js";

const HEARTBEAT_OUTCOME_SUMMARY_MAX_CHARS = 4_000;
const HEARTBEAT_OUTCOME_REASON_MAX_CHARS = 1_000;
const HEARTBEAT_OUTCOME_NEXT_CHECK_MAX_CHARS = 500;
const HEARTBEAT_OUTCOME_WAKE_REASON_MAX_CHARS = 1_000;
const HEARTBEAT_OUTCOME_TASK_NAME_MAX_CHARS = 200;
const HEARTBEAT_OUTCOME_MAX_TASKS = 32;

export type HeartbeatOutcomeStorage = {
  options: ReturnType<typeof toDatabaseOptions>;
  execution?: OpenClawAgentDatabaseExecution;
};

/** Capture before wake/delivery awaits so a retired invocation cannot reopen storage. */
export function captureHeartbeatOutcomeStorage(
  params: Parameters<typeof resolveSqliteScope>[0],
): HeartbeatOutcomeStorage {
  const resolved = toDatabaseOptions(resolveSqliteScope(params));
  const options = {
    ...resolved,
    path: resolveOpenClawAgentSqlitePath(resolved),
    env: { ...(resolved.env ?? process.env) },
  };
  return {
    options,
    ...(supportsOpenClawAgentDatabaseExecution(options)
      ? { execution: captureOpenClawAgentDatabaseExecution(options) }
      : {}),
  };
}

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
  storage?: HeartbeatOutcomeStorage;
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
  const storage = params.storage ?? captureHeartbeatOutcomeStorage(params);
  const execution = storage.execution;
  if (execution) {
    await runOpenClawAgentWorkerWrite(storage.options, () =>
      execution.run(undefined, (scope) =>
        scope.execute({ type: "heartbeat.persist", input: values }),
      ),
    );
    return;
  }
  runOpenClawAgentWriteTransaction(
    ({ db }) => persistHeartbeatOutcomeInDatabase(db, values),
    storage.options,
    { operationLabel: "heartbeat.outcome.persist" },
  );
}

/** Claims the latest outcome for one user run while allowing that run's retries. */
export async function claimHeartbeatOutcomeForRun(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  runId: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  workerSource?: AgentDatabaseExecutionSource;
}): Promise<PersistedHeartbeatOutcome | undefined> {
  const resolved = toDatabaseOptions(resolveSqliteScope(params));
  const options = {
    ...resolved,
    path: resolveOpenClawAgentSqlitePath(resolved),
    env: { ...(resolved.env ?? process.env) },
  };
  if (params.workerSource && supportsOpenClawAgentDatabaseExecution(options)) {
    const execution = captureOpenClawAgentDatabaseExecution(options);
    const workerSource = params.workerSource;
    const assertCurrent = params.assertCurrent;
    const source: AgentDatabaseExecutionSource = {
      assertCurrent() {
        workerSource.assertCurrent();
        assertCurrent?.();
      },
      admitTransaction(operation, grant) {
        workerSource.admitTransaction(operation, () => {
          assertCurrent?.();
          return grant();
        });
      },
    };
    const input = { sessionKey: params.sessionKey, runId: params.runId };
    const row = await runOpenClawAgentWorkerWrite(options, () =>
      execution.run(source, (scope) => scope.execute({ type: "heartbeat.claim", input })),
    );
    return row ? rowToOutcome(row) : undefined;
  }
  // Native-only scopes and narrower sources retain their existing owner during this cutover.
  return runOpenClawAgentWriteTransaction(
    ({ db }) => {
      params.assertCurrent?.();
      const row = claimHeartbeatOutcomeRowInDatabase(db, params);
      return row ? rowToOutcome(row) : undefined;
    },
    options,
    { operationLabel: "heartbeat.outcome.claim" },
  );
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
