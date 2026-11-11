import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  TOOL_USAGE_RETENTION_MS,
  type ToolUsageCatalogEntry,
  type ToolUsageRow,
} from "../../agents/tool-usage.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseOperations } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabasePreparationExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { prepareSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { createSessionWorkerExecutionSource } from "./session-worker-execution-source.js";
import type { AgentToolUsageImportResult, AgentToolUsageStatus } from "./tool-usage.types.js";

export type AgentToolUsageOptions = {
  agentId: string;
  config?: OpenClawConfig;
  now?: number;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
};
export type {
  AgentToolUsageState,
  AgentToolUsageStatus,
  AgentToolUsageImportResult,
} from "./tool-usage.types.js";

type UsageOperation = Extract<keyof AgentDatabaseOperations, `toolUsage.${string}`>;

function withDatabase<T>(
  input: AgentToolUsageOptions,
  operation: (options: OpenClawAgentDatabaseOptions, assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const agentId = normalizeAgentId(input.agentId);
  input.assertCurrent?.();
  // Ranking belongs to the executing agent, not a configured shared transcript store.
  const options = { agentId, env };
  return operation(
    { ...options, path: resolveOpenClawAgentSqlitePath(options) },
    input.assertCurrent ?? (() => {}),
  );
}

async function write<Key extends UsageOperation>(
  options: OpenClawAgentDatabaseOptions,
  assertCurrent: () => void,
  type: Key,
  input: AgentDatabaseOperations[Key]["input"],
): Promise<AgentDatabaseOperations[Key]["output"]> {
  assertCurrent();
  const execution = captureOpenClawAgentDatabasePreparationExecution(options);
  const source = createSessionWorkerExecutionSource(assertCurrent, "Tool usage database changed");
  try {
    return await runOpenClawAgentWorkerWrite(options, async () => {
      await execution.prepare(source);
      const result = await execution.runExisting(source, async (worker) => ({
        value: await worker.execute({ type, input }),
      }));
      if (!result) {
        throw new Error("Tool usage database disappeared before write");
      }
      return result.value;
    });
  } finally {
    await execution.release();
  }
}

export function readAgentToolUsageStatus(
  input: AgentToolUsageOptions,
): Promise<AgentToolUsageStatus> {
  const now = input.now ?? Date.now();
  return withDatabase(input, (options) =>
    withSessionHistoryWorkerDatabase(options, (owner) =>
      owner.readAgentToolUsage({ now, env: options.env ?? {} }),
    ),
  );
}

export async function readAgentToolUsage(input: AgentToolUsageOptions): Promise<ToolUsageRow[]> {
  return (await readAgentToolUsageStatus(input)).rows;
}

export function flushAgentToolUsage(
  input: AgentToolUsageOptions & {
    rows: readonly ToolUsageRow[];
    generation: number;
    runId?: string;
    startedAt?: number;
  },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  // Copy only the small turn accumulator before yielding to writer admission.
  const rows = input.rows.map((row) => ({ ...row }));
  return withDatabase(input, (options, current) =>
    write(options, current, "toolUsage.flush", {
      rows,
      generation: input.generation,
      runId: input.runId,
      startedAt: input.startedAt,
      now,
    }),
  );
}

/** A stale run's pending batch cannot recreate reset rows, even after an in-flight import. */
export async function resetAgentToolUsage(input: AgentToolUsageOptions) {
  const { discardPendingAgentToolUsage } = await import("../../agents/tool-usage-recorder.js");
  const now = input.now ?? Date.now();
  const state = await withDatabase(input, (options, current) =>
    write(options, current, "toolUsage.reset", { now }),
  );
  discardPendingAgentToolUsage(normalizeAgentId(input.agentId), state.generation);
  return state;
}

export async function importAgentToolUsage(
  input: AgentToolUsageOptions & {
    catalog: readonly ToolUsageCatalogEntry[];
    sinceDays?: number;
    dryRun?: boolean;
  },
): Promise<AgentToolUsageImportResult> {
  const now = input.now ?? Date.now();
  const sinceDays = input.sinceDays ?? 90;
  if (!Number.isSafeInteger(sinceDays) || sinceDays < 1 || sinceDays > 90) {
    throw new Error("Tool usage import sinceDays must be an integer between 1 and 90");
  }
  const since = Math.max(
    0,
    Math.floor(now - Math.min(TOOL_USAGE_RETENTION_MS, sinceDays * 86_400_000)),
  );
  const catalog = input.catalog.map(({ id, name }) => ({ id, name }));
  const { captureActiveAgentToolUsageRuns } = await import("../../agents/tool-usage-recorder.js");
  const activeRunIds = captureActiveAgentToolUsageRuns(normalizeAgentId(input.agentId));
  return withDatabase(input, async (options, current) => {
    const state = await withSessionHistoryWorkerDatabase(options, (owner) =>
      owner.readAgentToolUsage({ now, env: options.env ?? {} }),
    );
    const before = now;
    const source = input.config?.session?.store
      ? await prepareSqliteTargetFromSessionStorePath(
          resolveSessionStorePathForScope(
            { agentId: input.agentId, env: options.env },
            input.config,
          ),
          { agentId: input.agentId, env: options.env },
        )
      : options;
    const scan = await withSessionHistoryWorkerDatabase(
      { ...options, path: source.path, agentId: source.agentId ?? options.agentId },
      (owner) =>
        owner.readAgentToolUsageImport({
          catalog,
          since,
          before,
          executingAgentId: normalizeAgentId(input.agentId),
          counterDatabase: { agentId: options.agentId!, path: options.path! },
          previous: state,
          activeRunIds,
          env: options.env ?? {},
        }),
    );
    current();
    const applied =
      !input.dryRun &&
      (await write(options, current, "toolUsage.import", {
        expected: state,
        rows: scan.rows,
        since,
        now,
      }));
    return {
      ...scan,
      since,
      before,
      dryRun: input.dryRun === true,
      applied,
      lastImportAt: applied ? now : state.lastImportAt,
    };
  });
}

/** Existing Gateway maintenance owns scheduling and joins these admitted writes at shutdown. */
export async function pruneRegisteredAgentToolUsage(input: {
  env?: NodeJS.ProcessEnv;
  now: number;
  assertCurrent: () => void;
}) {
  const { listOpenClawRegisteredAgentDatabasesAsync } =
    await import("../../state/openclaw-agent-db-registry-listing.js");
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const entries = await listOpenClawRegisteredAgentDatabasesAsync({ env });
  for (const entry of entries) {
    input.assertCurrent();
    await write(
      { agentId: entry.agentId, path: entry.path, env },
      input.assertCurrent,
      "toolUsage.prune",
      { now: input.now },
    );
  }
}
