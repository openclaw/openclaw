import type { RuntimeEnv } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";

type GatewayHealthFailureDiagnostics = {
  service?: {
    label: string;
    loaded: boolean;
    loadedText: string;
    runtimeStatus?: string;
    state?: string;
    pid?: number;
    lastExitStatus?: number;
    lastExitReason?: string;
  };
  lastGatewayError?: string;
  inspectError?: string;
};

export function logNonInteractiveOnboardingJson(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  mode: "local" | "remote";
  workspaceDir?: string;
  authChoice?: string;
  gateway?: {
    port: number;
    bind: string;
    authMode: string;
    tailscaleMode: string;
  };
  installDaemon?: boolean;
  daemonRuntime?: string;
  skipSkills?: boolean;
  skipHealth?: boolean;
}) {
  if (!params.opts.json) {
    return;
  }
  params.runtime.log(
    JSON.stringify(
      {
        ok: true,
        mode: params.mode,
        workspace: params.workspaceDir,
        authChoice: params.authChoice,
        gateway: params.gateway,
        installDaemon: Boolean(params.installDaemon),
        daemonRuntime: params.daemonRuntime,
        skipSkills: Boolean(params.skipSkills),
        skipHealth: Boolean(params.skipHealth),
      },
      null,
      2,
    ),
  );
}

function formatGatewayRuntimeSummary(
  diagnostics: GatewayHealthFailureDiagnostics | undefined,
): string | undefined {
  const service = diagnostics?.service;
  if (!service?.runtimeStatus) {
    return undefined;
  }
  const parts = [service.runtimeStatus];
  if (typeof service.pid === "number") {
    parts.push(`pid ${service.pid}`);
  }
  if (service.state) {
    parts.push(`state ${service.state}`);
  }
  if (typeof service.lastExitStatus === "number") {
    parts.push(`last exit ${service.lastExitStatus}`);
  }
  if (service.lastExitReason) {
    parts.push(`reason ${service.lastExitReason}`);
  }
  return parts.join(", ");
}

export function logNonInteractiveOnboardingFailure(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  mode: "local" | "remote";
  phase: string;
  message: string;
  detail?: string;
  hints?: string[];
  gateway?: {
    wsUrl?: string;
    httpUrl?: string;
  };
  installDaemon?: boolean;
  daemonRuntime?: string;
  diagnostics?: GatewayHealthFailureDiagnostics;
}) {
  const hints = params.hints?.filter(Boolean) ?? [];
  const gatewayRuntime = formatGatewayRuntimeSummary(params.diagnostics);

  if (params.opts.json) {
    params.runtime.error(
      JSON.stringify(
        {
          ok: false,
          mode: params.mode,
          phase: params.phase,
          message: params.message,
          detail: params.detail,
          gateway: params.gateway,
          installDaemon: Boolean(params.installDaemon),
          daemonRuntime: params.daemonRuntime,
          diagnostics: params.diagnostics,
          hints: hints.length > 0 ? hints : undefined,
        },
        null,
        2,
      ),
    );
    return;
  }

  const lines = [
    params.message,
    params.detail ? `Last probe: ${params.detail}` : undefined,
    params.diagnostics?.service
      ? `Service: ${params.diagnostics.service.label} (${params.diagnostics.service.loaded ? params.diagnostics.service.loadedText : "not loaded"})`
      : undefined,
    gatewayRuntime ? `Runtime: ${gatewayRuntime}` : undefined,
    params.diagnostics?.lastGatewayError
      ? `Last gateway error: ${params.diagnostics.lastGatewayError}`
      : undefined,
    params.diagnostics?.inspectError
      ? `Diagnostics warning: ${params.diagnostics.inspectError}`
      : undefined,
    hints.length > 0 ? hints.join("\n") : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  params.runtime.error(lines);
}
