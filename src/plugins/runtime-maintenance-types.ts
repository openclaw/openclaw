import type { HealthCheck } from "../flows/health-checks.js";

/** Live authority for one explicit install/update, revoked when its checks settle. */
export interface PluginRuntimeMaintenanceContextV1 {
  readonly operation: "install" | "update";
  readonly pluginRoot: string;
  readonly signal: AbortSignal;
  /** Revalidate after awaited work and immediately before publishing a runtime. */
  assertCurrent(): void;
}

/** Optional light doctor-health-api export. It must not register global checks. */
export interface PluginRuntimeMaintenanceApiV1 {
  createPluginRuntimeMaintenanceChecksV1(
    context: PluginRuntimeMaintenanceContextV1,
  ): readonly HealthCheck[];
}
