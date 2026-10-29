import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";
import { formatCliJsonFailure } from "../cli/failure-output.js";
import { promptYesNo } from "../cli/prompt.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { openUrlPrivately } from "../infra/browser-handoff.js";
import { copyToClipboard } from "../infra/clipboard.js";
import { isRemoteEnvironment } from "../infra/remote-env.js";
import { defaultRuntime, ExitError, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { sleep } from "../utils/sleep.js";
import {
  hasVerifiedControlUiLoopbackAlias,
  issueControlUiBrowserHandoff,
  resolveControlUiHandoffTarget,
  waitForControlUiDocument,
} from "./control-ui-handoff.js";
import { gatewayProbeResultSawGateway } from "./gateway-health-auth-diagnostic.js";
import { detectBrowserOpenSupport, formatControlUiSshHint } from "./onboard-helpers.js";

const quietRuntime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: () => {},
};

const gatewayPasswordJsonKey = ["gateway", "Password"].join("");

async function resolveDashboardTarget() {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(
      `OpenClaw config is invalid: ${snapshot.path}. Run \`openclaw doctor --fix\` or \`openclaw config validate\`.`,
    );
  }
  return await resolveControlUiHandoffTarget({
    config: snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {},
    env: process.env,
  });
}

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
    ? `Gateway check failed: ${status.rpc.error}`
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

async function ensureDashboardTargetReady(params: {
  target: Awaited<ReturnType<typeof resolveDashboardTarget>>;
  runtime: RuntimeEnv;
  yes?: boolean;
  allowRecovery?: boolean;
}) {
  const { runtime, yes, allowRecovery } = params;
  const probeUrl = params.target.probeUrl;
  const gatherStatus = async () => {
    const { gatherDaemonStatus } = await import("../cli/daemon-cli/status.gather.js");
    return gatherDaemonStatus({
      rpc: probeUrl ? { url: probeUrl } : {},
      probe: true,
      requireRpc: false,
      deep: false,
    });
  };

  const initialStatus = await gatherStatus();
  if (gatewayIsReady(initialStatus)) {
    return { ready: true as const, recovered: false };
  }

  const reason = readinessFailureReason(initialStatus);
  const nativeServiceCanRecover = nativeServiceTargetsGateway(initialStatus);
  const canStartService = gatewayLooksStopped(initialStatus) && nativeServiceCanRecover;
  const shouldInstall = canStartService && !gatewayServiceIsInstalled(initialStatus);
  if (!canStartService || (shouldInstall && allowRecovery === false)) {
    printGatewayNotReadyHints(runtime, reason, canStartService);
    return { ready: false as const, reason };
  }

  const prompt = shouldInstall
    ? "No background Gateway service was detected for this profile. Install and start one to open the dashboard?"
    : "The background Gateway service is not running. Start it to open the dashboard?";
  const interactive = allowRecovery !== false && process.stdin.isTTY;
  const approved = yes || (interactive && (await promptYesNo(prompt, true)));
  if (!approved) {
    printGatewayNotReadyHints(runtime, reason);
    return { ready: false as const, reason, declined: interactive };
  }

  if (shouldInstall) {
    const { runDaemonInstall } = await import("../cli/daemon-cli/install.js");
    await runDaemonInstall({ json: false });
  } else {
    const { runDaemonStart } = await import("../cli/daemon-cli/lifecycle.js");
    await runDaemonStart({ json: false });
  }

  let recoveredStatus = await gatherStatus();
  for (let attempt = 1; attempt < 20 && !gatewayIsReady(recoveredStatus); attempt += 1) {
    await sleep(500);
    recoveredStatus = await gatherStatus();
  }
  if (gatewayIsReady(recoveredStatus)) {
    return { ready: true as const, recovered: true };
  }

  const recoveredReason = readinessFailureReason(recoveredStatus);
  const recoverable =
    gatewayLooksStopped(recoveredStatus) && nativeServiceTargetsGateway(recoveredStatus);
  printGatewayNotReadyHints(runtime, recoveredReason, recoverable);
  return {
    ready: false as const,
    reason: recoveredReason,
  };
}

function dashboardJsonFailure(runtime: RuntimeEnv, reason: string): void {
  const failure = formatCliJsonFailure(reason);
  writeRuntimeJson(runtime, { ...failure, reason }, 0);
  runtime.error(
    `${failure.error.message}\nRun \`openclaw gateway status --deep\` for details, then retry \`openclaw dashboard --json\`.`,
  );
  runtime.exit(1);
}

export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: {
    json?: boolean;
    noOpen?: boolean;
    yes?: boolean;
  } = {},
) {
  if (options.json) {
    try {
      const target = await resolveDashboardTarget();
      const readiness = await ensureDashboardTargetReady({
        target,
        runtime: quietRuntime,
        allowRecovery: false,
      });
      if (!readiness.ready) {
        dashboardJsonFailure(runtime, readiness.reason);
        return;
      }
      if (!(await hasVerifiedControlUiLoopbackAlias(target))) {
        dashboardJsonFailure(
          runtime,
          "Dashboard loopback listener could not be verified as the configured Gateway.",
        );
        return;
      }

      const document = await waitForControlUiDocument({
        url: target.documentUrl,
        tlsConfig: target.tlsConfig,
        waitForPending: false,
      });
      if (!document.ready) {
        dashboardJsonFailure(runtime, document.reason);
        return;
      }
      const browserHandoff = await issueControlUiBrowserHandoff(target.links);

      writeRuntimeJson(
        runtime,
        {
          ok: true,
          url: target.dashboardUrl,
          httpUrl: target.links.httpUrl,
          wsUrl: target.links.wsUrl,
          port: target.port,
          tokenIncluded: target.includeTokenInUrl,
          browserUrl: browserHandoff.browserUrl,
          browserBootstrapExpiresAtMs: browserHandoff.expiresAtMs,
          ...(target.gatewayAuthHandoff
            ? { [gatewayPasswordJsonKey]: target.gatewayAuthHandoff }
            : {}),
          ...(document.tlsFingerprint ? { tlsFingerprint: document.tlsFingerprint } : {}),
        },
        0,
      );
    } catch (err) {
      if (err instanceof ExitError) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      dashboardJsonFailure(runtime, reason || "Dashboard target resolution failed.");
    }
    return;
  }

  let initialTarget: Awaited<ReturnType<typeof resolveDashboardTarget>>;
  try {
    initialTarget = await resolveDashboardTarget();
  } catch (error) {
    runtime.error(error instanceof Error ? error.message : String(error));
    runtime.exit(1);
    return;
  }
  const readiness = await ensureDashboardTargetReady({
    target: initialTarget,
    runtime,
    yes: options.yes,
  });
  if (!readiness.ready) {
    if (!readiness.declined) {
      runtime.exit(1);
    }
    return;
  }

  const target = readiness.recovered ? await resolveDashboardTarget() : initialTarget;
  const recoveryChangedProbe = target.probeUrl !== initialTarget.probeUrl;
  if (readiness.recovered && recoveryChangedProbe) {
    // Recovery may install or start against a changed config. Prove the final
    // endpoint without triggering a second lifecycle action before URL delivery.
    const finalReadiness = await ensureDashboardTargetReady({
      target,
      runtime,
      allowRecovery: false,
    });
    if (!finalReadiness.ready) {
      runtime.exit(1);
      return;
    }
  }
  if (!(await hasVerifiedControlUiLoopbackAlias(target))) {
    runtime.error(
      "Dashboard loopback listener could not be verified as the configured Gateway; refusing to copy or open an authenticated URL.",
    );
    runtime.log("Restart the Gateway, then run `openclaw gateway status --deep` for details.");
    runtime.exit(1);
    return;
  }
  const document = await waitForControlUiDocument({
    url: target.documentUrl,
    tlsConfig: target.tlsConfig,
    onPending: () => runtime.log("Control UI assets are preparing; waiting for the dashboard…"),
  });
  if (!document.ready) {
    runtime.error(document.reason);
    runtime.log("Run `openclaw gateway status --deep` for details.");
    runtime.exit(1);
    return;
  }
  let browserUrl: string;
  try {
    browserUrl = (await issueControlUiBrowserHandoff(target.links)).browserUrl;
  } catch (error) {
    runtime.error(
      `Could not create a one-time browser pairing link: ${error instanceof Error ? error.message : String(error)}`,
    );
    runtime.log("Run `openclaw doctor`, then retry `openclaw dashboard`.");
    runtime.exit(1);
    return;
  }
  const { port, basePath, links, includeTokenInUrl, tlsConfig } = target;

  runtime.log(`Dashboard URL: ${links.httpUrl}`);
  runtime.log("One-time browser pairing included in browser/clipboard URL.");

  const copied = await copyToClipboard(browserUrl).catch(() => false);
  runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");

  let opened = false;
  let hint: string | undefined;
  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      // The handoff URL carries the one-time pairing credential in its
      // fragment. Open it through a private file handoff so the credential
      // never appears in a browser-opener process argument, where another
      // OS user could read it from /proc on default procfs hosts.
      opened = await openUrlPrivately(browserUrl);
    }
    if (!browserSupport.ok || (!opened && !copied && isRemoteEnvironment())) {
      hint = formatControlUiSshHint({
        port,
        basePath,
        tlsEnabled: tlsConfig?.enabled === true,
      });
    } else {
      hint = opened
        ? undefined
        : copied
          ? "Browser launch failed. Open the one-time pairing URL copied to clipboard."
          : "Browser launch failed. Open the Dashboard URL above manually.";
    }
  } else {
    hint = copied
      ? "Browser launch disabled (--no-open). One-time browser pairing URL copied to clipboard."
      : "Browser launch disabled (--no-open). Use the URL above.";
  }

  const handoffDeliveryFailed = !copied && !opened;
  const suppressNoOpenHint = options.noOpen === true && handoffDeliveryFailed;

  if (opened) {
    runtime.log("Opened in your browser. Keep that tab to control OpenClaw.");
  } else if (hint && !suppressNoOpenHint) {
    runtime.log(hint);
  }

  if (handoffDeliveryFailed) {
    runtime.log(
      includeTokenInUrl
        ? "Token auto-auth not delivered. Append your gateway token (from OPENCLAW_GATEWAY_TOKEN or gateway.auth.token) as a URL fragment with key `token` to authenticate."
        : "One-time pairing URL not delivered. Run `openclaw dashboard --json` and open its `browserUrl` within ten minutes.",
    );
  }
}
