/** CLI entrypoint for non-mutating Doctor lint health checks. */
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { DoctorLintCliOptions } from "./doctor-lint-options.js";

/** Delegate rehearsal lint before loading the worker's health-check graph. */
export async function runDoctorLintCli(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
): Promise<number> {
  if (runtime === defaultRuntime && opts.json && resolveUpdateRehearsalRoot(process.env)) {
    const { hasCliProcessScope } = await import("../cli/runtime-cleanup-scope.js");
    if (hasCliProcessScope()) {
      const { runUpdateDoctorLintProcess } = await import("./doctor-lint-process.js");
      const { resolveDoctorUpdateBudget } = await import("../flows/doctor-update-budget.js");
      const budget = await resolveDoctorUpdateBudget({ cfg: {}, env: process.env });
      return runUpdateDoctorLintProcess(opts, budget?.disposalDeadlineMs);
    }
  }
  const { runDoctorLintCliInProcess } = await import("./doctor-lint-runner.js");
  return runDoctorLintCliInProcess(runtime, opts);
}
