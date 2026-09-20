import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import type { HealthCheck, HealthCheckContext, HealthFinding } from "./health-checks.js";

export async function collectRuntimeToolSchemaFindingsWithRuntime(
  ctx: HealthCheckContext & {
    runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
  },
): Promise<readonly HealthFinding[]> {
  const runtime = await import("./doctor-core-checks.runtime.js");
  const { runWithPluginMetadataSnapshot } = ctx;
  return runtime.collectRuntimeToolSchemaFindings(ctx.cfg, {
    mode: ctx.mode,
    env: ctx.env,
    ...(runWithPluginMetadataSnapshot ? { runWithPluginMetadataSnapshot } : {}),
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
