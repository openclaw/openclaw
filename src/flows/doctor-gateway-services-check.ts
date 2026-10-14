import { classifyLegacyServices } from "../commands/doctor-gateway-legacy-services.js";
import type {
  HealthCheck,
  HealthCheckContext,
  HealthFinding,
  HealthRepairContext,
  HealthRepairEffect,
} from "./health-checks.js";

const CHECK_ID = "core/doctor/gateway-services/extra";
type GatewayServicesContext = {
  readonly deep?: boolean;
};

async function inspectGatewayServices(ctx: GatewayServicesContext) {
  const { detectExtraGatewayServiceIssues } =
    await import("../commands/doctor-gateway-services.js");
  return detectExtraGatewayServiceIssues({ deep: ctx.deep === true });
}

export const gatewayServicesExtraCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  description: "Extra gateway-like services and incomplete inspection are reported as findings.",
  source: "doctor",
  async detect(ctx: HealthCheckContext & GatewayServicesContext) {
    const { services, errors } = await inspectGatewayServices(ctx);
    const findings: HealthFinding[] = services.map((service) => ({
      checkId: CHECK_ID,
      severity: service.legacy === true ? "warning" : "info",
      message: `Other gateway-like service detected: ${service.label} (${service.scope}, ${service.detail})`,
      source: service.platform,
      target: service.label,
      fixHint:
        service.legacy === true
          ? "Run `openclaw doctor` interactively to review legacy gateway services and confirm supported cleanup."
          : "Run a single gateway per machine unless this extra gateway is intentional.",
    }));
    return findings.concat(
      errors.map((error): HealthFinding => ({
        checkId: CHECK_ID,
        severity: "warning",
        message: `Gateway service inspection incomplete: ${error.message}`,
        source: "doctor",
        target: error.source,
        fixHint:
          "Restore access to the native service definition or service manager, then run `openclaw doctor --deep` again.",
      })),
    );
  },
  async repair(ctx: HealthRepairContext & GatewayServicesContext) {
    const { services } = await inspectGatewayServices(ctx);
    const { darwinUserServices, linuxUserServices } = classifyLegacyServices(
      services.filter((service) => service.legacy === true),
    );
    const effects: HealthRepairEffect[] = [...darwinUserServices, ...linuxUserServices].map(
      (service) => ({
        kind: "service",
        action: "would-remove-legacy-gateway-service",
        target: service.label,
        dryRunSafe: false,
      }),
    );
    return ctx.dryRun === true
      ? { status: "repaired", changes: [], effects }
      : {
          status: "skipped",
          reason: "legacy doctor gateway service contribution owns cleanup",
          changes: [],
          effects,
        };
  },
};
