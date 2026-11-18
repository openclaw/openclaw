// Runs the configure wizard's target-bound Gateway health check.
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../gateway/probe-auth.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import type { DaemonSetupOutcome } from "./configure.daemon.js";
import { resolveGatewayStartupTiming } from "./gateway-startup-timing.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommandNonExiting } from "./health.js";
import { resolveLocalControlUiProbeLinks, waitForGatewayReachable } from "./onboard-helpers.js";

export type GatewayHealthCheckOutcome = "succeeded" | "failed" | "skipped";

export async function runGatewayHealthCheck(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  port: number;
  daemonSetupOutcome?: DaemonSetupOutcome;
}): Promise<GatewayHealthCheckOutcome> {
  const localLinks = resolveLocalControlUiProbeLinks({
    bind: params.cfg.gateway?.bind ?? "loopback",
    port: params.port,
    customBindHost: params.cfg.gateway?.customBindHost,
    basePath: undefined,
    tlsEnabled: params.cfg.gateway?.tls?.enabled === true,
  });
  const remoteUrl = params.cfg.gateway?.remote?.url?.trim();
  const remoteWsUrl = params.cfg.gateway?.mode === "remote" ? remoteUrl : undefined;
  const probeMode = remoteWsUrl ? "remote" : "local";
  const wsUrl = remoteWsUrl ?? localLinks.wsUrl;
  const probeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
    cfg: params.cfg,
    env: process.env,
    mode: probeMode,
    ...(probeMode === "local" ? { localPrecedence: "env-first" as const } : {}),
  });
  if (probeAuth.warning) {
    // Only remote mode can retain a resolved sibling credential after a failed ref.
    const canUseOtherCredential =
      probeMode === "remote" && Boolean(probeAuth.auth.token || probeAuth.auth.password);
    note(
      [
        `Could not resolve ${probeMode} gateway SecretRef for health check.`,
        probeAuth.warning,
        ...(canUseOtherCredential
          ? ["Continuing with the other configured remote credential."]
          : [
              "Health check skipped to avoid falling back to ambient credentials.",
              `Fix the SecretRef, then run \`${formatCliCommand("openclaw health")}\` again.`,
            ]),
      ].join("\n"),
      "Gateway auth",
    );
    if (!canUseOtherCredential) {
      return "skipped";
    }
  }
  const { token, password } = probeAuth.auth;

  try {
    const gatewayProbe = await waitForGatewayReachable({
      url: wsUrl,
      ...(probeMode === "remote"
        ? { config: params.cfg, originScopedDeviceAuth: true, configuredRemote: true }
        : {}),
      token,
      password,
      ...(params.daemonSetupOutcome === "succeeded"
        ? resolveGatewayStartupTiming()
        : { deadlineMs: 15_000 }),
    });
    if (!gatewayProbe.ok) {
      throw new Error(gatewayProbe.detail ?? `gateway did not become reachable at ${wsUrl}`);
    }
    await healthCommandNonExiting(
      {
        json: false,
        timeoutMs: 10_000,
        config: params.cfg,
        token,
        password,
        ...(probeMode === "local"
          ? { localPortOverride: params.port }
          : { ignoreEnvUrlOverride: true }),
      },
      params.runtime,
    );
  } catch (err) {
    // A trapped ExitError means healthCommand already printed its own
    // reachable-gateway diagnostic; re-formatting it would only add noise.
    if (!(err instanceof ExitError)) {
      params.runtime.error(formatHealthCheckFailure(err));
    }
    note(
      [
        "Docs:",
        "https://docs.openclaw.ai/gateway/health",
        "https://docs.openclaw.ai/gateway/troubleshooting",
      ].join("\n"),
      "Health check help",
    );
    return "failed";
  }
  return "succeeded";
}
