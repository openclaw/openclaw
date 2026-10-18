import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { parseGatewayPortOption } from "../cli/gateway-port-option.js";
import { parseTimeoutMsWithFallback } from "../cli/parse-timeout.js";
import { withProgress } from "../cli/progress.js";
import { readBestEffortConfig } from "../config/config.js";
import { ensureExplicitGatewayAuth, resolveExplicitGatewayAuth } from "../gateway/call.js";
import { resolveGatewaySshRemotePort } from "../gateway/connection-details.js";
import { resolveWideAreaDiscoveryDomain } from "../infra/widearea-dns.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import {
  inferSshTargetFromRemoteUrl,
  resolveSshTarget,
  serializeGatewayDiscoveryBeacon,
} from "./gateway-status/discovery.js";
import {
  buildNetworkHints,
  resolveTargets,
  sanitizeSshTarget,
  isProbeReachable,
  isPostConnectProbeFailure,
  isScopeLimitedProbeFailure,
  summarizeGatewayProbeCapability,
  renderProbeSummaryLine,
  renderTargetHeader,
} from "./gateway-status/helpers.js";
import { buildGatewayStatusWarnings, pickPrimaryProbedTarget } from "./gateway-status/output.js";
import { runGatewayStatusProbePass } from "./gateway-status/probe-run.js";

export async function gatewayStatusCommand(
  opts: {
    url?: string;
    token?: string;
    password?: string;
    port?: unknown;
    timeout?: unknown;
    json?: boolean;
    ssh?: string;
    sshIdentity?: string;
    sshAuto?: boolean;
  },
  runtime: RuntimeEnv,
) {
  await ensureExplicitGatewayAuth({
    urlOverride: opts.url?.trim(),
    urlOverrideSource: "cli",
    explicitAuth: resolveExplicitGatewayAuth(opts),
    errorHint: "Fix: pass --token or --password with --url.",
  });
  const startedAt = Date.now();
  const cfg = await readBestEffortConfig();
  const rich = isRich() && opts.json !== true;
  const defaultTimeoutMs = 3000;
  const overallTimeoutMs = parseTimeoutMsWithFallback(opts.timeout, defaultTimeoutMs, {
    invalidType: "error",
  });
  const portOverride = parseGatewayPortOption(opts.port);
  const wideAreaDomain = resolveWideAreaDiscoveryDomain({
    configDomain: cfg.discovery?.wideArea?.domain,
  });
  const baseTargets = resolveTargets(cfg, opts.url, portOverride);
  const network = buildNetworkHints(cfg, portOverride);
  const remotePort = portOverride ?? resolveGatewaySshRemotePort(cfg);
  const discoveryTimeoutMs = Math.min(1200, overallTimeoutMs);
  const hasExplicitUrl = typeof opts.url === "string" && opts.url.trim().length > 0;
  const useConfiguredRemoteTargets = portOverride === undefined || hasExplicitUrl;

  let sshTarget =
    sanitizeSshTarget(opts.ssh) ??
    (useConfiguredRemoteTargets ? sanitizeSshTarget(cfg.gateway?.remote?.sshTarget) : null);
  let sshIdentity =
    sanitizeSshTarget(opts.sshIdentity) ??
    (useConfiguredRemoteTargets ? sanitizeSshTarget(cfg.gateway?.remote?.sshIdentity) : null);

  if (!sshTarget && useConfiguredRemoteTargets) {
    // Remote URL inference gives users a useful SSH default without requiring
    // gateway.remote.sshTarget when the host already appears in config.
    sshTarget = inferSshTargetFromRemoteUrl(cfg.gateway?.remote?.url);
  }

  const sshRouteTarget = sshTarget;
  if (sshTarget) {
    const resolved = await resolveSshTarget({
      rawTarget: sshTarget,
      identity: sshIdentity,
      overallTimeoutMs,
    });
    if (resolved) {
      sshTarget = resolved.target;
      if (!sshIdentity && resolved.identity) {
        sshIdentity = resolved.identity;
      }
    }
  }

  const localCertificate =
    cfg.gateway?.tls?.enabled === true
      ? await import("../infra/tls/gateway.js").then(({ inspectGatewayTlsCertificate }) =>
          inspectGatewayTlsCertificate(cfg.gateway?.tls),
        )
      : undefined;

  const controller = new AbortController();
  let abortSignal: "SIGINT" | "SIGTERM" | undefined;
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (!abortSignal) {
      abortSignal = signal;
      controller.abort();
    }
  };
  const onSigInt = () => onSignal("SIGINT");
  const onSigTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  const probePass = await (async () => {
    try {
      return await withProgress(
        {
          label: "Inspecting gateways…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () =>
          await runGatewayStatusProbePass({
            cfg,
            opts,
            overallTimeoutMs,
            discoveryTimeoutMs,
            wideAreaDomain,
            baseTargets,
            remotePort,
            sshTarget,
            sshRouteTarget,
            sshIdentity,
            localTlsFingerprint: localCertificate?.ok
              ? localCertificate.value.fingerprintSha256
              : undefined,
            signal: controller.signal,
          }),
      );
    } finally {
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
    }
  })();
  if (abortSignal) {
    runtime.exit(abortSignal === "SIGINT" ? 130 : 143);
    return;
  }

  const warnings = buildGatewayStatusWarnings({
    probed: probePass.probed,
    sshTarget: probePass.sshTarget,
    sshTunnelStarted: probePass.sshTunnelStarted,
    sshTunnelError: probePass.sshTunnelError,
    discoveryCount: probePass.discovery.length,
    localTlsLoadError: localCertificate && !localCertificate.ok ? localCertificate.error : null,
  });
  const primary = pickPrimaryProbedTarget(probePass.probed);

  const reachable = probePass.probed.filter((entry) => isProbeReachable(entry.probe));
  const capability = summarizeGatewayProbeCapability(reachable.map((entry) => entry.probe));

  if (opts.json) {
    const degraded = probePass.probed.some((entry) => isPostConnectProbeFailure(entry.probe));
    writeRuntimeJson(runtime, {
      ok: reachable.length > 0,
      degraded,
      capability,
      ts: Date.now(),
      durationMs: Date.now() - startedAt,
      timeoutMs: overallTimeoutMs,
      primaryTargetId: primary?.target.id ?? null,
      warnings,
      network,
      discovery: {
        timeoutMs: discoveryTimeoutMs,
        count: probePass.discovery.length,
        beacons: probePass.discovery.map(serializeGatewayDiscoveryBeacon),
      },
      targets: probePass.probed.map((entry) => ({
        id: entry.target.id,
        kind: entry.target.kind,
        url: entry.target.url,
        active: entry.target.active,
        tunnel: entry.target.tunnel ?? null,
        connect: {
          ok: isProbeReachable(entry.probe),
          rpcOk: entry.probe.ok,
          scopeLimited: isScopeLimitedProbeFailure(entry.probe),
          latencyMs: entry.probe.connectLatencyMs,
          error: entry.probe.error,
          close: entry.probe.close,
        },
        auth: entry.probe.auth,
        server: entry.probe.server,
        self: entry.self,
        config: entry.configSummary,
        health: entry.probe.health,
        summary: entry.probe.status,
        presence: entry.probe.presence,
      })),
    });
    if (reachable.length === 0) {
      runtime.exit(1);
    }
    return;
  }

  const ok = reachable.length > 0;
  runtime.log(colorize(rich, theme.heading, "Gateway Status"));
  runtime.log(
    ok
      ? `${colorize(rich, theme.success, "Reachable")}: yes`
      : `${colorize(rich, theme.error, "Reachable")}: no`,
  );
  runtime.log(`${colorize(rich, theme.info, "Capability")}: ${capability.replaceAll("_", "-")}`);
  runtime.log(colorize(rich, theme.muted, `Check budget: ${overallTimeoutMs}ms`));

  if (warnings.length > 0) {
    runtime.log("");
    runtime.log(colorize(rich, theme.warn, "Warning:"));
    for (const warning of warnings) {
      runtime.log(`- ${warning.message}`);
    }
  }

  runtime.log("");
  runtime.log(colorize(rich, theme.heading, "Discovery (this machine)"));
  const discoveryDomains = wideAreaDomain ? `local. + ${wideAreaDomain}` : "local.";
  runtime.log(
    `Found ${probePass.discovery.length} ${probePass.discovery.length > 0 ? "gateway(s)" : "gateways"} via Bonjour (${discoveryDomains})`,
  );
  if (probePass.discovery.length === 0) {
    runtime.log(
      colorize(
        rich,
        theme.muted,
        "Tip: if the gateway is remote, mDNS won’t cross networks; use Wide-Area Bonjour (split DNS) or SSH tunnels.",
      ),
    );
  }

  runtime.log("");
  runtime.log(colorize(rich, theme.heading, "Targets"));
  for (const result of probePass.probed) {
    runtime.log(renderTargetHeader(result.target, rich));
    runtime.log(`  ${renderProbeSummaryLine(result.probe, rich)}`);
    if (result.target.tunnel?.kind === "ssh") {
      runtime.log(
        `  ${colorize(rich, theme.muted, "ssh")}: ${colorize(rich, theme.command, result.target.tunnel.target)}`,
      );
    }
    if (result.probe.ok && result.self) {
      const host = result.self.host ?? "unknown";
      const ip = result.self.ip ? ` (${result.self.ip})` : "";
      const platform = result.self.platform ? ` · ${result.self.platform}` : "";
      const version = result.self.version ? ` · app ${result.self.version}` : "";
      runtime.log(`  ${colorize(rich, theme.info, "Gateway")}: ${host}${ip}${platform}${version}`);
    }
    if (result.configSummary) {
      const wideArea =
        result.configSummary.discovery.wideAreaEnabled === true
          ? "enabled"
          : result.configSummary.discovery.wideAreaEnabled === false
            ? "disabled"
            : "unknown";
      runtime.log(`  ${colorize(rich, theme.info, "Wide-area discovery")}: ${wideArea}`);
    }
    runtime.log("");
  }

  if (!ok) {
    runtime.exit(1);
  }
}
