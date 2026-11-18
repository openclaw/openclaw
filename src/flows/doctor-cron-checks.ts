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
  description: "Legacy automations can retain an authorized inference account.",
  async detect(ctx) {
    const { maybeRepairCronInferenceBindings } =
      await import("../commands/doctor/cron/inference-binding-migration.js");
    const { warnings } = await maybeRepairCronInferenceBindings({
      cfg: ctx.cfg,
      env: ctx.env,
      shouldRepair: false,
    });
    return warnings.map((message): HealthFinding => ({
      checkId: "core/doctor/cron-inference-accounts",
      severity: "warning",
      category: "fix-now",
      message,
      path: resolveOpenClawStateSqlitePath(ctx.env),
      requirement: "cron-inference-account",
      fixHint:
        "Run openclaw doctor --fix to record the planned eligible account; otherwise follow the account selection command in the finding.",
    }));
  },
};
