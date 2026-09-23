import { formatUnsupportedNodeVersionMessage } from "../../node-version.mjs";
import { shouldManageGatewayService } from "../commands/doctor-service-repair-policy.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { resolveNodeRuntimeInfo } from "../daemon/runtime-paths.js";
import {
  getSystemdCgroupHygieneSummary,
  type GatewayServiceRuntime,
} from "../daemon/service-runtime.js";
import { resolveGatewayService, readGatewayServiceState } from "../daemon/service.js";
import type { HealthCheckContext, HealthFinding } from "./health-checks.js";

function gatewayRuntimeStatus(runtime: GatewayServiceRuntime | undefined): string | undefined {
  return runtime?.status ?? runtime?.state ?? runtime?.subState;
}

export async function collectGatewayDaemonFindings(
  ctx: Pick<HealthCheckContext, "cfg">,
): Promise<readonly HealthFinding[]> {
  if (ctx.cfg.gateway?.mode === "remote" || !(await shouldManageGatewayService())) {
    return [];
  }
  const service = resolveGatewayService();
  const state = await readGatewayServiceState(service, { env: process.env });
  const findings: HealthFinding[] = [];
  if (state.loadState.status === "unknown") {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: `Gateway service status could not be determined: ${state.loadState.detail}`,
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: "Run `openclaw gateway status --deep`, restore service-manager access, and retry.",
    });
    return findings;
  }
  if (!state.installed) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service is not installed.",
      path: "gateway.mode",
      target: service.label,
      fixHint:
        service.managementUnsupportedReason ??
        "Run `openclaw gateway install` to install the service.",
    });
    return findings;
  }
  const nodePath = state.command?.programArguments[0];
  if (nodePath && isNodeRuntime(nodePath)) {
    const runtime = await resolveNodeRuntimeInfo(nodePath, state.env);
    const message =
      runtime.status === "probe-failed"
        ? runtime.error.message
        : (runtime.capabilityError ?? runtime.note);
    if (message) {
      findings.push({
        checkId: "core/doctor/gateway-daemon",
        severity: runtime.status === "supported" ? "info" : "warning",
        message,
        path: state.command?.sourcePath,
        target: nodePath,
        ...(runtime.status !== "supported"
          ? {
              fixHint: [
                ...(runtime.status === "unsupported"
                  ? [formatUnsupportedNodeVersionMessage(runtime.version)]
                  : []),
                "Repair the Node runtime, then run `openclaw gateway install`.",
              ].join("\n"),
            }
          : {}),
      });
    }
  }
  if (state.loadState.status === "not-loaded") {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service is installed but not loaded.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: "Start the installed service with `openclaw gateway start`.",
    });
  }
  const status = gatewayRuntimeStatus(state.runtime);
  if (state.loadState.status === "loaded" && !state.running) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: status
        ? `Gateway service runtime is ${status}, not running.`
        : "Gateway service is loaded but runtime status could not confirm it is running.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint:
        "Run `openclaw gateway status --deep` to inspect the service before choosing a recovery action.",
    });
  }
  if (state.runtime?.missingGuiSession) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service cannot attach to the user GUI session.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: state.runtime.detail ?? "Log into a GUI session, then rerun doctor.",
    });
  }
  if (state.runtime?.missingUnit) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service supervision metadata is missing.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: state.runtime.detail ?? "Reinstall or reload the Gateway service.",
    });
  }
  const hygiene = getSystemdCgroupHygieneSummary(state.runtime?.systemd);
  if (hygiene) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: `Gateway systemd service has risky ${hygiene}.`,
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: "Repair the systemd unit so stale child processes are cleaned up reliably.",
    });
  }
  return findings;
}
