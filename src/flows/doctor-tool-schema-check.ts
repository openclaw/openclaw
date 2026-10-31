import type { DoctorHealthCheckContext } from "./doctor-health-contribution-types.js";
import type { HealthCheck } from "./health-checks.js";

export const runtimeToolSchemaCheck: HealthCheck = {
  id: "core/doctor/runtime-tool-schemas",
  kind: "core",
  description: "Active agent tool schemas project into model/runtime-compatible tool inputs.",
  source: "doctor",
  async detect(ctx: DoctorHealthCheckContext) {
    const runtime = await import("./doctor-tool-schema-runtime.js");
    const { runWithPluginMetadataSnapshot, deferInspectionDisposal } = ctx;
    return runtime.collectRuntimeToolSchemaFindings(ctx.cfg, {
      mode: ctx.mode,
      env: ctx.env,
      ...(runWithPluginMetadataSnapshot ? { runWithPluginMetadataSnapshot } : {}),
      ...(deferInspectionDisposal ? { deferInspectionDisposal } : {}),
    });
  },
};
