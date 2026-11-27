import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type { HealthFinding } from "./health-checks.js";

type CoreHealthCheck = Omit<DoctorHealthCheck, "kind" | "source">;

export const legacyCronStoreCheck: CoreHealthCheck = {
  id: "core/doctor/legacy-cron-store",
  description: "Legacy cron store, run-log, and payload state is normalized.",
  defaultEnabled: false,
  async detect(ctx) {
    const { collectLegacyCronStoreHealthFindings } =
      await import("../commands/doctor/cron/index.js");
    return collectLegacyCronStoreHealthFindings({ cfg: ctx.cfg });
  },
};

export const cronInferenceCheck: CoreHealthCheck = {
  id: "core/doctor/cron-inference-accounts",
  description: "Saved automation accounts can move to explicit model selections.",
  async detect(ctx) {
    const { maybeRepairCronInferenceBindings } =
      await import("../commands/doctor/cron/inference-binding-migration.js");
    const { warnings, notices } = await maybeRepairCronInferenceBindings({
      cfg: ctx.cfg,
      env: ctx.env,
      shouldRepair: false,
    });
    const path = resolveOpenClawStateSqlitePath(ctx.env);
    return [...warnings, ...notices].map((message, index): HealthFinding => ({
      checkId: "core/doctor/cron-inference-accounts",
      severity: "warning",
      category: index < warnings.length ? "fix-now" : "recommended",
      message,
      path,
      requirement: "cron-inference-account",
      ...(index < warnings.length
        ? { fixHint: "Run openclaw doctor --fix to convert saved automation accounts." }
        : {}),
    }));
  },
};
