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
    const common = {
      checkId: "core/doctor/cron-inference-accounts",
      severity: "warning",
      path: resolveOpenClawStateSqlitePath(ctx.env),
      requirement: "cron-inference-account",
    } as const;
    const findings: HealthFinding[] = [];
    for (const message of warnings) {
      findings.push({
        ...common,
        category: "fix-now",
        message,
        fixHint: "Run openclaw doctor --fix to convert saved automation accounts.",
      });
    }
    for (const message of notices) {
      findings.push({ ...common, category: "recommended", message });
    }
    return findings;
  },
};
