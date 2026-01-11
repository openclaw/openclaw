import { withProgress } from "../cli/progress.js";
import { loadConfig, resolveGatewayPort } from "../config/config.js";
import type { ClawdbotConfig, ConfigFileSnapshot } from "../config/types.js";
import { type GatewayProbeResult, probeGateway } from "../gateway/probe.js";
import { discoverGatewayBeacons } from "../infra/bonjour-discovery.js";
import { startSshPortForward } from "../infra/ssh-tunnel.js";
import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import type { RuntimeEnv } from "../runtime.js";
import { colorize, isRich, theme } from "../terminal/theme.js";

type TargetKind = "explicit" | "configRemote" | "localLoopback" | "sshTunnel";

type GatewayStatusTarget = {
  id: string;
  kind: TargetKind;
  url: string;
  active: boolean;
  tunnel?: {
    kind: "ssh";
    target: string;
    localPort: number;
    remotePort: number;
    pid: number | null;
  };
};

type GatewayConfigSummary = {
  path: string | null;
  exists: boolean;
  valid: boolean;
  issues: Array<{ path: string; message: string }>;
  legacyIssues: Array<{ path: string; message: string }>;
  gateway: {
    mode: string | null;
    bind: string | null;
    port: number | null;
    controlUiEnabled: boolean | null;
    controlUiBasePath: string | null;
    authMode: string | null;
    authTokenConfigured: boolean;
    authPasswordConfigured: boolean;
    remoteUrl: string | null;
    remoteTokenConfigured: boolean;
    remotePasswordConfigured: boolean;
    tailscaleMode: string | null;
  };
  bridge: {
    enabled: boolean | null;
    bind: string | null;
    port: number | null;
  };
  discovery: {
    wideAreaEnabled: boolean | null;
  };
};

function parseIntOrNull(value: unknown): number | null {
  const s =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : "";
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseTimeoutMs(raw: unknown, fallbackMs: number): number {
  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "bigint"
        ? String(raw)
        : "";
  if (!value) return fallbackMs;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid --timeout: ${value}`);
  }
  return parsed;
}

function normalizeWsUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://"))
    return null;
  return trimmed;
}

function resolveTargets(
  cfg: ClawdbotConfig,
  explicitUrl?: string,
): GatewayStatusTarget[] {
  const targets: GatewayStatusTarget[] = [];
  const add = (t: GatewayStatusTarget) => {
    if (!targets.some((x) => x.url === t.url)) targets.push(t);
  };

  const explicit =
    typeof explicitUrl === "string" ? normalizeWsUrl(explicitUrl) : null;
  if (explicit)
    add({ id: "explicit", kind: "explicit", url: explicit, active: true });

  const remoteUrl =
    typeof cfg.gateway?.remote?.url === "string"
      ? normalizeWsUrl(cfg.gateway.remote.url)
      : null;
  if (remoteUrl) {
    add({
      id: "configRemote",
      kind: "configRemote",
      url: remoteUrl,
      active: cfg.gateway?.mode === "remote",
    });
  }

  const port = resolveGatewayPort(cfg);
  add({
    id: "localLoopback",
    kind: "localLoopback",
    url: `ws://127.0.0.1:${port}`,
    active: cfg.gateway?.mode !== "remote",
  });

  return targets;
}

function resolveProbeBudgetMs(overallMs: number, kind: TargetKind): number {
  if (kind === "localLoopback") return Math.min(800, overallMs);
  if (kind === "sshTunnel") return Math.min(2000, overallMs);
  return Math.min(1500, overallMs);
}

function sanitizeSshTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^ssh\s+/, "");
}

function resolveAuthForTarget(
  cfg: ClawdbotConfig,
  target: GatewayStatusTarget,
  overrides: { token?: string; password?: string },
): { token?: string; password?: string } {
  const tokenOverride = overrides.token?.trim()
    ? overrides.token.trim()
    : undefined;
  const passwordOverride = overrides.password?.trim()
    ? overrides.password.trim()
    : undefined;
  if (tokenOverride || passwordOverride) {
    return { token: tokenOverride, password: passwordOverride };
  }

  if (target.kind === "configRemote") {
    const token =
      typeof cfg.gateway?.remote?.token === "string"
        ? cfg.gateway.remote.token.trim()
        : "";
    const remotePassword = (
      cfg.gateway?.remote as { password?: unknown } | undefined
    )?.password;
    const password =
      typeof remotePassword === "string" ? remotePassword.trim() : "";
    return {
      token: token.length > 0 ? token : undefined,
      password: password.length > 0 ? password : undefined,
    };
  }

  const envToken = process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() || "";
  const envPassword = process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() || "";
  const cfgToken =
    typeof cfg.gateway?.auth?.token === "string"
      ? cfg.gateway.auth.token.trim()
      : "";
  const cfgPassword =
    typeof cfg.gateway?.auth?.password === "string"
      ? cfg.gateway.auth.password.trim()
      : "";

  return {
    token: envToken || cfgToken || undefined,
    password: envPassword || cfgPassword || undefined,
  };
}

function pickGatewaySelfPresence(
  presence: unknown,
): { host?: string; ip?: string; version?: string; platform?: string } | null {
  if (!Array.isArray(presence)) return null;
  const entries = presence as Array<Record<string, unknown>>;
  const self =
    entries.find((e) => e.mode === "gateway" && e.reason === "self") ??
    entries.find(
      (e) =>
        typeof e.text === "string" && String(e.text).startsWith("Gateway:"),
    ) ??
    null;
  if (!self) return null;
  return {
    host: typeof self.host === "string" ? self.host : undefined,
    ip: typeof self.ip === "string" ? self.ip : undefined,
    version: typeof self.version === "string" ? self.version : undefined,
    platform: typeof self.platform === "string" ? self.platform : undefined,
  };
}

function extractConfigSummary(snapshotUnknown: unknown): GatewayConfigSummary {
  const snap = snapshotUnknown as Partial<ConfigFileSnapshot> | null;
  const path = typeof snap?.path === "string" ? snap.path : null;
  const exists = Boolean(snap?.exists);
  const valid = Boolean(snap?.valid);
  const issuesRaw = Array.isArray(snap?.issues) ? snap.issues : [];
  const legacyRaw = Array.isArray(snap?.legacyIssues) ? snap.legacyIssues : [];

  const cfg = (snap?.config ?? {}) as Record<string, unknown>;
  const gateway = (cfg.gateway ?? {}) as Record<string, unknown>;
  const bridge = (cfg.bridge ?? {}) as Record<string, unknown>;
  const discovery = (cfg.discovery ?? {}) as Record<string, unknown>;
  const wideArea = (discovery.wideArea ?? {}) as Record<string, unknown>;

  const remote = (gateway.remote ?? {}) as Record<string, unknown>;
  const auth = (gateway.auth ?? {}) as Record<string, unknown>;
  const controlUi = (gateway.controlUi ?? {}) as Record<string, unknown>;
  const tailscale = (gateway.tailscale ?? {}) as Record<string, unknown>;

  const authMode = typeof auth.mode === "string" ? auth.mode : null;
  const authTokenConfigured =
    typeof auth.token === "string" ? auth.token.trim().length > 0 : false;
  const authPasswordConfigured =
    typeof auth.password === "string" ? auth.password.trim().length > 0 : false;

  const remoteUrl =
    typeof remote.url === "string" ? normalizeWsUrl(remote.url) : null;
  const remoteTokenConfigured =
    typeof remote.token === "string" ? remote.token.trim().length > 0 : false;
  const remotePasswordConfigured =
    typeof remote.password === "string"
      ? String(remote.password).trim().length > 0
      : false;

  const bridgeEnabled =
    typeof bridge.enabled === "boolean" ? bridge.enabled : null;
  const bridgeBind = typeof bridge.bind === "string" ? bridge.bind : null;
  const bridgePort = parseIntOrNull(bridge.port);

  const wideAreaEnabled =
    typeof wideArea.enabled === "boolean" ? wideArea.enabled : null;

  return {
    path,
    exists,
    valid,
    issues: issuesRaw
      .filter((i): i is { path: string; message: string } =>
        Boolean(
          i && typeof i.path === "string" && typeof i.message === "string",
        ),
      )
      .map((i) => ({ path: i.path, message: i.message })),
    legacyIssues: legacyRaw
      .filter((i): i is { path: string; message: string } =>
        Boolean(
          i && typeof i.path === "string" && typeof i.message === "string",
        ),
      )
      .map((i) => ({ path: i.path, message: i.message })),
    gateway: {
      mode: typeof gateway.mode === "string" ? gateway.mode : null,
      bind: typeof gateway.bind === "string" ? gateway.bind : null,
      port: parseIntOrNull(gateway.port),
      controlUiEnabled:
        typeof controlUi.enabled === "boolean" ? controlUi.enabled : null,
      controlUiBasePath:
        typeof controlUi.basePath === "string" ? controlUi.basePath : null,
      authMode,
      authTokenConfigured,
      authPasswordConfigured,
      remoteUrl,
      remoteTokenConfigured,
      remotePasswordConfigured,
      tailscaleMode: typeof tailscale.mode === "string" ? tailscale.mode : null,
    },
    bridge: {
      enabled: bridgeEnabled,
      bind: bridgeBind,
      port: bridgePort,
    },
    discovery: { wideAreaEnabled },
  };
}

function buildNetworkHints(cfg: ClawdbotConfig) {
  const tailnetIPv4 = pickPrimaryTailnetIPv4();
  const port = resolveGatewayPort(cfg);
  return {
    localLoopbackUrl: `ws://127.0.0.1:${port}`,
    localTailnetUrl: tailnetIPv4 ? `ws://${tailnetIPv4}:${port}` : null,
    tailnetIPv4: tailnetIPv4 ?? null,
  };
}

function renderTargetHeader(target: GatewayStatusTarget, rich: boolean) {
  const kindLabel =
    target.kind === "localLoopback"
      ? "Local loopback"
      : target.kind === "sshTunnel"
        ? "Remote over SSH"
        : target.kind === "configRemote"
          ? target.active
            ? "Remote (configured)"
            : "Remote (configured, inactive)"
          : "URL (explicit)";
  return `${colorize(rich, theme.heading, kindLabel)} ${colorize(rich, theme.muted, target.url)}`;
}

function renderProbeSummaryLine(probe: GatewayProbeResult, rich: boolean) {
  if (probe.ok) {
    const latency =
      typeof probe.connectLatencyMs === "number"
        ? `${probe.connectLatencyMs}ms`
        : "unknown";
    return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${colorize(rich, theme.success, "RPC: ok")}`;
  }

  const detail = probe.error ? ` - ${probe.error}` : "";
  if (probe.connectLatencyMs != null) {
    const latency =
      typeof probe.connectLatencyMs === "number"
        ? `${probe.connectLatencyMs}ms`
        : "unknown";
    return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${colorize(rich, theme.error, "RPC: failed")}${detail}`;
  }

  return `${colorize(rich, theme.error, "Connect: failed")}${detail}`;
}

export async function gatewayStatusCommand(
  opts: {
    url?: string;
    token?: string;
    password?: string;
    timeout?: unknown;
    json?: boolean;
    ssh?: string;
    sshIdentity?: string;
    sshAuto?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const startedAt = Date.now();
  const cfg = loadConfig();
  const rich = isRich() && opts.json !== true;
  const overallTimeoutMs = parseTimeoutMs(opts.timeout, 3000);

  const baseTargets = resolveTargets(cfg, opts.url);
  const network = buildNetworkHints(cfg);

  const discoveryTimeoutMs = Math.min(1200, overallTimeoutMs);
  const discoveryPromise = discoverGatewayBeacons({
    timeoutMs: discoveryTimeoutMs,
  });

  let sshTarget =
    sanitizeSshTarget(opts.ssh) ??
    sanitizeSshTarget(cfg.gateway?.remote?.sshTarget);
  const sshIdentity =
    sanitizeSshTarget(opts.sshIdentity) ??
    sanitizeSshTarget(cfg.gateway?.remote?.sshIdentity);
  const remotePort = resolveGatewayPort(cfg);

  let sshTunnelError: string | null = null;
  let sshTunnelStarted = false;

  const { discovery, probed } = await withProgress(
    {
      label: "Inspecting gateways…",
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () => {
      const tryStartTunnel = async () => {
        if (!sshTarget) return null;
        try {
          const tunnel = await startSshPortForward({
            target: sshTarget,
            identity: sshIdentity ?? undefined,
            localPortPreferred: remotePort,
            remotePort,
            timeoutMs: Math.min(1500, overallTimeoutMs),
          });
          sshTunnelStarted = true;
          return tunnel;
        } catch (err) {
          sshTunnelError = err instanceof Error ? err.message : String(err);
          return null;
        }
      };

      const discoveryTask = discoveryPromise.catch(() => []);
      const tunnelTask = sshTarget ? tryStartTunnel() : Promise.resolve(null);

      const [discovery, tunnelFirst] = await Promise.all([
        discoveryTask,
        tunnelTask,
      ]);

      if (!sshTarget && opts.sshAuto) {
        const user = process.env.USER?.trim() || "";
        const candidates = discovery
          .map((b) => {
            const host = b.tailnetDns || b.lanHost || b.host;
            if (!host?.trim()) return null;
            const sshPort =
              typeof b.sshPort === "number" && b.sshPort > 0 ? b.sshPort : 22;
            const base = user ? `${user}@${host.trim()}` : host.trim();
            return sshPort !== 22 ? `${base}:${sshPort}` : base;
          })
          .filter((x): x is string => Boolean(x));
        if (candidates.length > 0) sshTarget = candidates[0] ?? null;
      }

      const tunnel =
        tunnelFirst ||
        (sshTarget && !sshTunnelStarted && !sshTunnelError
          ? await tryStartTunnel()
          : null);

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
        ? [
            tunnelTarget,
            ...baseTargets.filter((t) => t.url !== tunnelTarget.url),
          ]
        : baseTargets;

      try {
        const probed = await Promise.all(
          targets.map(async (target) => {
            const auth = resolveAuthForTarget(cfg, target, {
              token: typeof opts.token === "string" ? opts.token : undefined,
              password:
                typeof opts.password === "string" ? opts.password : undefined,
            });
            const timeoutMs = resolveProbeBudgetMs(
              overallTimeoutMs,
              target.kind,
            );
            const probe = await probeGateway({
              url: target.url,
              auth,
              timeoutMs,
            });
            const configSummary = probe.configSnapshot
              ? extractConfigSummary(probe.configSnapshot)
              : null;
            const self = pickGatewaySelfPresence(probe.presence);
            return { target, probe, configSummary, self };
          }),
        );

        return { discovery, probed };
      } finally {
        if (tunnel) {
          try {
            await tunnel.stop();
          } catch {
            // best-effort
          }
        }
      }
    },
  );

  const reachable = probed.filter((p) => p.probe.ok);
  const ok = reachable.length > 0;
  const multipleGateways = reachable.length > 1;
  const primary =
    reachable.find((p) => p.target.kind === "explicit") ??
    reachable.find((p) => p.target.kind === "sshTunnel") ??
    reachable.find((p) => p.target.kind === "configRemote") ??
    reachable.find((p) => p.target.kind === "localLoopback") ??
    null;

  const warnings: Array<{
    code: string;
    message: string;
    targetIds?: string[];
  }> = [];
  if (sshTarget && !sshTunnelStarted) {
    warnings.push({
      code: "ssh_tunnel_failed",
      message: sshTunnelError
        ? `SSH tunnel failed: ${String(sshTunnelError)}`
        : "SSH tunnel failed to start; falling back to direct probes.",
    });
  }
  if (multipleGateways) {
    warnings.push({
      code: "multiple_gateways",
      message:
        "Unconventional setup: multiple reachable gateways detected. Usually only one gateway should exist on a network.",
      targetIds: reachable.map((p) => p.target.id),
    });
  }

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          ok,
          ts: Date.now(),
          durationMs: Date.now() - startedAt,
          timeoutMs: overallTimeoutMs,
          primaryTargetId: primary?.target.id ?? null,
          warnings,
          network,
          discovery: {
            timeoutMs: discoveryTimeoutMs,
            count: discovery.length,
            beacons: discovery.map((b) => ({
              instanceName: b.instanceName,
              displayName: b.displayName ?? null,
              domain: b.domain ?? null,
              host: b.host ?? null,
              lanHost: b.lanHost ?? null,
              tailnetDns: b.tailnetDns ?? null,
              bridgePort: b.bridgePort ?? null,
              gatewayPort: b.gatewayPort ?? null,
              sshPort: b.sshPort ?? null,
              wsUrl: (() => {
                const host = b.tailnetDns || b.lanHost || b.host;
                const port = b.gatewayPort ?? 18789;
                return host ? `ws://${host}:${port}` : null;
              })(),
            })),
          },
          targets: probed.map((p) => ({
            id: p.target.id,
            kind: p.target.kind,
            url: p.target.url,
            active: p.target.active,
            tunnel: p.target.tunnel ?? null,
            connect: {
              ok: p.probe.ok,
              latencyMs: p.probe.connectLatencyMs,
              error: p.probe.error,
              close: p.probe.close,
            },
            self: p.self,
            config: p.configSummary,
            health: p.probe.health,
            summary: p.probe.status,
            presence: p.probe.presence,
          })),
        },
        null,
        2,
      ),
    );
    if (!ok) runtime.exit(1);
    return;
  }

  runtime.log(colorize(rich, theme.heading, "Gateway Status"));
  runtime.log(
    ok
      ? `${colorize(rich, theme.success, "Reachable")}: yes`
      : `${colorize(rich, theme.error, "Reachable")}: no`,
  );
  runtime.log(
    colorize(rich, theme.muted, `Probe budget: ${overallTimeoutMs}ms`),
  );

  if (warnings.length > 0) {
    runtime.log("");
    runtime.log(colorize(rich, theme.warn, "Warning:"));
    for (const w of warnings) runtime.log(`- ${w.message}`);
  }

  runtime.log("");
  runtime.log(colorize(rich, theme.heading, "Discovery (this machine)"));
  runtime.log(
    discovery.length > 0
      ? `Found ${discovery.length} gateway(s) via Bonjour (local. + clawdbot.internal.)`
      : "Found 0 gateways via Bonjour (local. + clawdbot.internal.)",
  );
  if (discovery.length === 0) {
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
  for (const p of probed) {
    runtime.log(renderTargetHeader(p.target, rich));
    runtime.log(`  ${renderProbeSummaryLine(p.probe, rich)}`);
    if (p.target.tunnel?.kind === "ssh") {
      runtime.log(
        `  ${colorize(rich, theme.muted, "ssh")}: ${colorize(rich, theme.command, p.target.tunnel.target)}`,
      );
    }
    if (p.probe.ok && p.self) {
      const host = p.self.host ?? "unknown";
      const ip = p.self.ip ? ` (${p.self.ip})` : "";
      const platform = p.self.platform ? ` · ${p.self.platform}` : "";
      const version = p.self.version ? ` · app ${p.self.version}` : "";
      runtime.log(
        `  ${colorize(rich, theme.info, "Gateway")}: ${host}${ip}${platform}${version}`,
      );
    }
    if (p.configSummary) {
      const c = p.configSummary;
      const bridge =
        c.bridge.enabled === false
          ? "disabled"
          : c.bridge.enabled === true
            ? "enabled"
            : "unknown";
      const wideArea =
        c.discovery.wideAreaEnabled === true
          ? "enabled"
          : c.discovery.wideAreaEnabled === false
            ? "disabled"
            : "unknown";
      runtime.log(
        `  ${colorize(rich, theme.info, "Bridge")}: ${bridge}${c.bridge.bind ? ` · bind ${c.bridge.bind}` : ""}${c.bridge.port ? ` · port ${c.bridge.port}` : ""}`,
      );
      runtime.log(
        `  ${colorize(rich, theme.info, "Wide-area discovery")}: ${wideArea}`,
      );
    }
    runtime.log("");
  }

  if (!ok) runtime.exit(1);
}
