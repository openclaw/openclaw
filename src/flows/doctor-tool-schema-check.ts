import type { DoctorHealthCheckContext } from "./doctor-health-contribution-types.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

export async function collectRuntimeToolSchemaFindingsWithRuntime(
  ctx: DoctorHealthCheckContext,
): Promise<readonly HealthFinding[]> {
  const runtime = await import("./doctor-tool-schema-runtime.js");
  const { runWithPluginMetadataSnapshot, deferInspectionDisposal } = ctx;
  return runtime.collectRuntimeToolSchemaFindings(ctx.cfg, {
    mode: ctx.mode,
    env: ctx.env,
    ...(runWithPluginMetadataSnapshot ? { runWithPluginMetadataSnapshot } : {}),
    ...(deferInspectionDisposal ? { deferInspectionDisposal } : {}),
  });
}

export function createRuntimeToolSchemaCheck(deps: {
  readonly collectRuntimeToolSchemaFindings: typeof collectRuntimeToolSchemaFindingsWithRuntime;
}): HealthCheck {
  return {
    id: "core/doctor/runtime-tool-schemas",
    kind: "core",
    description: "Active agent tool schemas project into model/runtime-compatible tool inputs.",
    source: "doctor",
    async detect(ctx) {
      return deps.collectRuntimeToolSchemaFindings(ctx);
    },
  };
}
