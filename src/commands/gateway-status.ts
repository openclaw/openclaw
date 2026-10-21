import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { parseGatewayPortOption } from "../cli/gateway-port-option.js";
import { parseTimeoutMsWithFallback } from "../cli/parse-timeout.js";
import { withProgress } from "../cli/progress.js";
import { readBestEffortConfig } from "../config/config.js";
import { ensureExplicitGatewayAuth, resolveExplicitGatewayAuth } from "../gateway/call.js";
import { resolveGatewaySshRemotePort } from "../gateway/connection-details.js";
import { probeGateway } from "../gateway/probe.js";
import { isAbortError } from "../infra/abort-signal.js";
import { discoverGatewayBeacons } from "../infra/bonjour-discovery.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  buildGatewayDiscoveryTarget,
  serializeGatewayDiscoveryBeacon,
} from "../infra/gateway-discovery-targets.js";
import { resolveWideAreaDiscoveryDomain } from "../infra/widearea-dns.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { pickGatewaySelfPresence } from "./gateway-presence.js";
import {
  buildNetworkHints,
  extractConfigSummary,
  resolveAuthForTarget,
  resolveProbeBudgetMs,
  type GatewayConfigSummary,
  type GatewayStatusTarget,
  resolveTargets,
  sanitizeSshTarget,
  isProbeReachable,
  isPostConnectProbeFailure,
  isScopeLimitedProbeFailure,
  summarizeGatewayProbeCapability,
  renderProbeSummaryLine,
  renderTargetHeader,
} from "./gateway-status/helpers.js";
type GatewayStatusProbedTarget = {
  target: GatewayStatusTarget;
  probe: Awaited<ReturnType<typeof probeGateway>>;
  configSummary: GatewayConfigSummary | null;
  self: ReturnType<typeof pickGatewaySelfPresence>;
  authDiagnostics: string[];
};

function buildSshTarget(input: { user?: string; host?: string; port?: number }): string | null {
  const host = normalizeOptionalString(input.host) ?? "";
  if (!host) {
    return null;
  }
  const user = normalizeOptionalString(input.user) ?? "";
  const base = user ? `${user}@${host}` : host;
  const port = input.port ?? 22;
  if (input.port !== undefined && port) {
    return `${base}:${port}`;
  }
  return base;
}

function gatewaySelfIdentityKey(entry: GatewayStatusProbedTarget): string | null {
  if (!entry.self) {
    return null;
  }
  const host = normalizeLowercaseStringOrEmpty(entry.self.host);
  const ip = normalizeLowercaseStringOrEmpty(entry.self.ip);
  const instanceId = normalizeLowercaseStringOrEmpty(entry.self.instanceId);
  const deviceId = normalizeLowercaseStringOrEmpty(entry.self.deviceId);
  const discriminator = instanceId
    ? `instance:${instanceId}`
    : deviceId
      ? `device:${deviceId}`
      : "";
  if ((!host && !ip) || !discriminator) {
    return null;
  }
  return `${host}\0${ip}\0${discriminator}`;
}

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
    const remoteUrl = normalizeOptionalString(cfg.gateway?.remote?.url);
    const host = remoteUrl ? URL.parse(remoteUrl)?.hostname : undefined;
    sshTarget = host ? buildSshTarget({ user: process.env.USER, host }) : null;
  }

  const sshRouteTarget = sshTarget;
  if (sshTarget) {
    const [{ resolveSshConfig }, { parseSshTarget }] = await Promise.all([
      import("../infra/ssh-config.js"),
      import("../infra/ssh-tunnel.js"),
    ]);
    const parsed = parseSshTarget(sshTarget);
    if (parsed) {
      const config = await resolveSshConfig(parsed, {
        explicitPort: /:\d+$/.test(sshTarget.trim()),
        identity: sshIdentity ?? undefined,
        timeoutMs: Math.min(800, overallTimeoutMs),
      });
      if (config) {
        const target = buildSshTarget({
          user: config.user ?? parsed.user,
          host: config.host ?? parsed.host,
          port: config.port ?? parsed.port,
        });
        if (target) {
          sshTarget = target;
          if (!sshIdentity) {
            sshIdentity =
              config.identityFiles.find((entry) => normalizeOptionalString(entry)) ?? null;
          }
        }
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
  const probePass = await (async (): Promise<{
    discovery: Awaited<ReturnType<typeof discoverGatewayBeacons>>;
    probed: GatewayStatusProbedTarget[];
    sshTarget: string | null;
    sshTunnelStarted: boolean;
    sshTunnelError: string | null;
  }> => {
    try {
      return await withProgress(
        {
          label: "Inspecting gateways…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () => {
          const discoveryPromise = discoverGatewayBeacons({
            timeoutMs: discoveryTimeoutMs,
            wideAreaDomain,
          });

          let sshTunnelError: string | null = null;

          const tryStartTunnel = async () => {
            if (!sshTarget) {
              return null;
            }
            if (controller.signal?.aborted) {
              sshTunnelError = "Aborted";
              return null;
            }
            try {
              const { startSshPortForward } = await import("../infra/ssh-tunnel.js");
              return await startSshPortForward({
                target: sshTarget,
                identity: sshIdentity ?? undefined,
                hostKeyPolicy: cfg.gateway?.remote?.sshHostKeyPolicy,
                localPortPreferred: remotePort,
                remotePort,
                timeoutMs: Math.min(1500, overallTimeoutMs),
                signal: controller.signal,
              });
            } catch (err) {
              sshTunnelError = isAbortError(err) ? "Aborted" : formatErrorMessage(err);
              return null;
            }
          };

          const discoveryTask = discoveryPromise.catch(() => []);
          const tunnelTask = sshTarget ? tryStartTunnel() : Promise.resolve(null);
          const [discovery, tunnelFirst] = await Promise.all([discoveryTask, tunnelTask]);

          if (!sshTarget && opts.sshAuto) {
            const { parseSshTarget } = await import("../infra/ssh-tunnel.js");
            const sshUser = normalizeOptionalString(process.env.USER) ?? "";
            for (const beacon of discovery) {
              const target = buildGatewayDiscoveryTarget(beacon, { sshUser }).sshTarget;
              if (target && parseSshTarget(target)) {
                sshTarget = target;
                break;
              }
            }
          }

          // Prefer the concurrently-started tunnel, but allow auto-discovered SSH
          // targets to start after Bonjour finishes.
          const tunnel =
            tunnelFirst || (sshTarget && !sshTunnelError ? await tryStartTunnel() : null);

          const tunnelTarget: GatewayStatusTarget | null = tunnel
            ? {
                id: "sshTunnel",
                kind: "sshTunnel",
                url: `ws://127.0.0.1:${tunnel.localPort}`,
                active: true,
                tunnel: {
                  kind: "ssh",
                  target: sshTarget ?? "",
                  localPort: tunnel.localPort,
                  remotePort,
                  pid: tunnel.pid,
                },
              }
            : null;

          const targets: GatewayStatusTarget[] = tunnelTarget
            ? [tunnelTarget, ...baseTargets.filter((target) => target.url !== tunnelTarget.url)]
            : baseTargets;

          try {
            const probed = await Promise.all(
              targets.map(async (target) => {
                const authResolution = await resolveAuthForTarget(cfg, target, {
                  token: readStringValue(opts.token),
                  password: readStringValue(opts.password),
                });
                const probe = await probeGateway({
                  url: target.url,
                  config: cfg,
                  configuredRemote: target.kind === "configRemote",
                  // The same selected route owns both token lookup and the live tunnel.
                  // Transfer that lifetime to the client; the finally block also covers
                  // failures before client construction.
                  ...(target.kind === "sshTunnel"
                    ? {
                        originScopedDeviceAuth: true,
                        sshTunnel: {
                          target: sshRouteTarget ?? sshTarget ?? "",
                          remotePort,
                          ...(sshIdentity ? { identity: sshIdentity } : {}),
                        },
                        preparedSshTunnel: tunnel ?? undefined,
                      }
                    : target.kind !== "localLoopback"
                      ? { originScopedDeviceAuth: true }
                      : {}),
                  auth: {
                    token: authResolution.token,
                    password: authResolution.password,
                  },
                  tlsFingerprint:
                    target.kind === "localLoopback" && target.url.startsWith("wss://")
                      ? localCertificate?.ok
                        ? localCertificate.value.fingerprintSha256
                        : undefined
                      : undefined,
                  timeoutMs: resolveProbeBudgetMs(overallTimeoutMs, target),
                  signal: controller.signal,
                });
                return {
                  target,
                  probe,
                  configSummary: probe.configSnapshot
                    ? extractConfigSummary(probe.configSnapshot)
                    : null,
                  self: pickGatewaySelfPresence(probe.presence),
                  authDiagnostics: authResolution.diagnostics ?? [],
                };
              }),
            );

            return {
              discovery,
              probed,
              sshTarget,
              sshTunnelStarted: Boolean(tunnel),
              sshTunnelError,
            };
          } finally {
            if (tunnel) {
              try {
                await tunnel.stop();
              } catch {
                // Status output must not fail just because tunnel cleanup races process exit.
              }
            }
          }
        },
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

  const reachable = probePass.probed.filter((entry) => isProbeReachable(entry.probe));
  const primary =
    reachable.find((entry) => entry.target.kind === "explicit") ??
    reachable.find((entry) => entry.target.kind === "sshTunnel") ??
    reachable.find((entry) => entry.target.kind === "configRemote") ??
    reachable.find((entry) => entry.target.kind === "localLoopback") ??
    null;
  const warnings: Array<{ code: string; message: string; targetIds?: string[] }> = [];
  if (probePass.sshTarget && !probePass.sshTunnelStarted) {
    warnings.push({
      code: "ssh_tunnel_failed",
      message: probePass.sshTunnelError
        ? `SSH tunnel failed: ${probePass.sshTunnelError}`
        : "SSH tunnel failed to start; falling back to direct checks.",
    });
  }
  if (localCertificate && !localCertificate.ok && localCertificate.error) {
    warnings.push({
      code: "local_tls_runtime_unavailable",
      message: `Local gateway TLS is enabled but OpenClaw could not load the local certificate fingerprint: ${localCertificate.error}`,
      targetIds: ["localLoopback"],
    });
  }
  if (reachable.length === 0 && probePass.discovery.length === 0) {
    warnings.push({
      code: "no_gateway_reachable",
      message:
        "No gateway answered any check and Bonjour discovery returned no local gateways. Run `openclaw gateway status --deep --require-rpc` to inspect service state, config paths, listener owners, and logs; include `ss -ltnp` or `lsof -nP -iTCP:<port> -sTCP:LISTEN` for the configured port when filing a report.",
      targetIds: probePass.probed.map((entry) => entry.target.id),
    });
  }
  const identityKeys = reachable.map(gatewaySelfIdentityKey);
  if (
    reachable.length > 1 &&
    (identityKeys.some((key) => key === null) || new Set(identityKeys).size > 1)
  ) {
    // Multiple reachable gateways are valid for isolated profiles but surprising
    // enough to call out before users debug against the wrong process.
    warnings.push({
      code: "multiple_gateways",
      message:
        "Unconventional setup: multiple reachable gateway identities detected. Usually one gateway per network is recommended unless you intentionally run isolated profiles, like a rescue bot (see docs: /gateway#multiple-gateways-same-host).",
      targetIds: reachable.map((entry) => entry.target.id),
    });
  }
  for (const result of probePass.probed) {
    if (result.authDiagnostics.length === 0 || isProbeReachable(result.probe)) {
      continue;
    }
    for (const diagnostic of result.authDiagnostics) {
      warnings.push({
        code: "auth_secretref_unresolved",
        message: diagnostic,
        targetIds: [result.target.id],
      });
    }
  }
  for (const result of probePass.probed.filter((entry) =>
    isScopeLimitedProbeFailure(entry.probe),
  )) {
    warnings.push({
      code: "probe_scope_limited",
      message:
        "Read-check diagnostics are limited by gateway scopes (missing operator.read). Connection succeeded, but read-only status calls are incomplete. Hint: pair device identity or use credentials with operator.read.",
      targetIds: [result.target.id],
    });
  }
  for (const result of probePass.probed.filter(
    (entry) => isPostConnectProbeFailure(entry.probe) && !isScopeLimitedProbeFailure(entry.probe),
  )) {
    const detail = result.probe.error ? `: ${result.probe.error}` : ".";
    warnings.push({
      code: "probe_detail_failed",
      message: `Gateway accepted the WebSocket connection, but follow-up read diagnostics failed${detail}`,
      targetIds: [result.target.id],
    });
  }
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
