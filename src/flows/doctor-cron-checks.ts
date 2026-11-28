import type { DoctorHealthCheck } from "./health-check-runner-types.js";

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
