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
  let token: string | undefined;
  let password: string | undefined;
  // Remote and local probe credentials belong to different trust surfaces.
  // Keep their resolution separate so one target never receives the other's secrets.
  if (probeMode === "remote") {
    const remoteProbeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: params.cfg,
      env: process.env,
      mode: "remote",
    });
    if (remoteProbeAuth.warning) {
      const hasResolvedRemoteAuth = Boolean(
        remoteProbeAuth.auth.token || remoteProbeAuth.auth.password,
      );
      note(
        [
          "Could not resolve remote gateway SecretRef for health check.",
          remoteProbeAuth.warning,
          ...(hasResolvedRemoteAuth
            ? ["Continuing with the other configured remote credential."]
            : [
                "Health check skipped to avoid falling back to ambient credentials.",
                `Fix the SecretRef, then run \`${formatCliCommand("openclaw health")}\` again.`,
              ]),
        ].join("\n"),
        "Gateway auth",
      );
      // A failed ref does not invalidate a resolved sibling config credential.
      // Skip only when generic health auth could otherwise recover ambient auth.
      if (!hasResolvedRemoteAuth) {
        return "skipped";
      }
    }
    ({ token, password } = remoteProbeAuth.auth);
  } else {
    const localProbeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: params.cfg,
      env: process.env,
      mode: "local",
      localPrecedence: "env-first",
    });
    if (localProbeAuth.warning) {
      note(
        [
          "Could not resolve local gateway SecretRef for health check.",
          localProbeAuth.warning,
          "Health check skipped to avoid falling back to ambient credentials.",
          `Fix the SecretRef, then run \`${formatCliCommand("openclaw health")}\` again.`,
        ].join("\n"),
        "Gateway auth",
      );
      return "skipped";
    }
    ({ token, password } = localProbeAuth.auth);
  }

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
