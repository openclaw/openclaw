import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";
import { promptYesNo } from "../cli/prompt.js";
import type { RuntimeEnv } from "../runtime.js";
import { gatewayProbeResultSawGateway } from "./gateway-health-auth-diagnostic.js";

type GatewayReadinessResult =
  | {
      ready: true;
      status: DaemonStatus;
      recovered: boolean;
    }
  | {
      ready: false;
      status: DaemonStatus;
      reason: string;
      recoverable: boolean;
    };

type GatewayReadinessOptions = {
  runtime: RuntimeEnv;
  yes?: boolean;
  allowInstall?: boolean;
  probeUrl?: string;
  interactive?: boolean;
};

function activeProbePortStatus(status: DaemonStatus): DaemonStatus["port"] {
  const probeUrl = status.rpc?.url ?? status.gateway?.probeUrl;
  const probePort = probeUrl
    ? (() => {
        try {
          return Number(new URL(probeUrl).port);
        } catch {
          return Number.NaN;
        }
      })()
    : Number.NaN;
  if (Number.isFinite(probePort) && status.portCli?.port === probePort) {
    return status.portCli;
  }
  return status.port;
}

function gatewayIsReady(status: DaemonStatus): boolean {
  // A busy port alone is not enough: pair it with probe evidence so another
  // local service on the same port cannot satisfy gateway readiness.
  return (
    status.rpc?.ok === true ||
    (activeProbePortStatus(status)?.status === "busy" &&
      Boolean(status.rpc && gatewayProbeResultSawGateway(status.rpc)))
  );
}

function gatewayLooksStopped(status: DaemonStatus): boolean {
  if (status.rpc && gatewayProbeResultSawGateway(status.rpc)) {
    return false;
  }
  const port = activeProbePortStatus(status);
  if (port?.status === "busy") {
    return false;
  }
  if (port?.status === "free") {
    return true;
  }
  const runtimeStatus = status.service.runtime?.status;
  if (runtimeStatus === "stopped") {
    return true;
  }
  const error = status.rpc?.error ?? "";
  return /\bECONNREFUSED\b|couldn't connect|connection refused/i.test(error);
}

function gatewayServiceIsInstalled(status: DaemonStatus): boolean {
  return Boolean(status.service.command || status.service.loadState.status === "loaded");
}

function nativeServiceTargetsGateway(status: DaemonStatus): boolean {
  return status.service.targetRole !== "diagnostic-only";
}

function readinessFailureReason(status: DaemonStatus): string {
  if (gatewayLooksStopped(status)) {
    return "Gateway is not running.";
  }
  return status.rpc?.error
    ? `Gateway probe failed: ${status.rpc.error}`
    : "Gateway is not healthy.";
}

function printGatewayNotReadyHints(
  runtime: RuntimeEnv,
  reason: string,
  canStartService = true,
): void {
  runtime.log(reason);
  runtime.log("Run `openclaw gateway status --deep` for details.");
  if (!canStartService) {
    runtime.log(
      "Use the owning environment or supervisor to start or repair the selected Gateway.",
    );
    return;
  }
  runtime.log("Run `openclaw gateway start` to start a managed gateway.");
  runtime.log("Run `openclaw gateway run` for a foreground gateway.");
}

export async function ensureDashboardGatewayReady(
  options: GatewayReadinessOptions,
): Promise<GatewayReadinessResult> {
  const gatherStatus = async () => {
    const { gatherDaemonStatus } = await import("../cli/daemon-cli/status.gather.js");
    return gatherDaemonStatus({
      rpc: options.probeUrl ? { url: options.probeUrl } : {},
      probe: true,
      requireRpc: false,
      deep: false,
    });
  };

  const initialStatus = await gatherStatus();
  if (gatewayIsReady(initialStatus)) {
    return { ready: true, status: initialStatus, recovered: false };
  }

  const reason = readinessFailureReason(initialStatus);
  const nativeServiceCanRecover = nativeServiceTargetsGateway(initialStatus);
  if (!gatewayLooksStopped(initialStatus) || !nativeServiceCanRecover) {
    printGatewayNotReadyHints(options.runtime, reason, false);
    return { ready: false, status: initialStatus, reason, recoverable: false };
  }

  const shouldInstall = !gatewayServiceIsInstalled(initialStatus);
  if (shouldInstall && options.allowInstall === false) {
    printGatewayNotReadyHints(options.runtime, reason);
    return { ready: false, status: initialStatus, reason, recoverable: false };
  }

  const prompt = shouldInstall
    ? "No background Gateway service was detected for this profile. Install and start one to open the dashboard?"
    : "The background Gateway service is not running. Start it to open the dashboard?";
  const approved =
    options.yes ||
    ((options.interactive ?? process.stdin.isTTY) && (await promptYesNo(prompt, true)));
  if (!approved) {
    printGatewayNotReadyHints(options.runtime, reason);
    return { ready: false, status: initialStatus, reason, recoverable: true };
  }

  if (shouldInstall) {
    const { runDaemonInstall } = await import("../cli/daemon-cli/install.runtime.js");
    await runDaemonInstall({ json: false });
  } else {
    const { runDaemonStart } = await import("../cli/daemon-cli/lifecycle.js");
    await runDaemonStart({ json: false });
  }

  let recoveredStatus = await gatherStatus();
  for (let attempt = 1; attempt < 20 && !gatewayIsReady(recoveredStatus); attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    recoveredStatus = await gatherStatus();
  }
  if (gatewayIsReady(recoveredStatus)) {
    return { ready: true, status: recoveredStatus, recovered: true };
  }

  const recoveredReason = readinessFailureReason(recoveredStatus);
  const recoverable =
    gatewayLooksStopped(recoveredStatus) && nativeServiceTargetsGateway(recoveredStatus);
  printGatewayNotReadyHints(options.runtime, recoveredReason, recoverable);
  return {
    ready: false,
    status: recoveredStatus,
    reason: recoveredReason,
    recoverable,
  };
}
