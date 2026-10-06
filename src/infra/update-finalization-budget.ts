import { tmpdir } from "node:os";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "./sqlite-readonly-worker.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";

// Core activation/finalization has six serial stages; plugins add per-install work.
const FINALIZE_PROCESS_STEP_BUDGET_MULTIPLIER = 6;

export async function resolveUpdateFinalizationTimeoutMs(
  perStepTimeoutMs?: number,
  options: {
    env?: NodeJS.ProcessEnv;
    databases?: readonly { path: string }[];
    observedStartupMs?: number;
    pluginCount?: number;
    nodeRunner?: string;
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const files = new Set([
    resolveOpenClawStateSqlitePath(env),
    ...(options.databases ?? []).map((database) => database.path),
  ]);
  const stateBudgetMs = resolveAggregateSqliteInspectionTimeoutMs(
    "update activation",
    await readUpdateStateDatabaseSizes([...files], {
      nodeRunner: options.nodeRunner ?? process.execPath,
      sourceEnv: env,
      stagingRoot: tmpdir(),
      timeoutMs: perStepTimeoutMs,
    }),
  );
  return (
    Math.max(
      perStepTimeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS,
      stateBudgetMs,
      options.observedStartupMs ?? 0,
    ) *
    (FINALIZE_PROCESS_STEP_BUDGET_MULTIPLIER + (options.pluginCount ?? 0))
  );
}
