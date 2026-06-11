import { existsSync } from "node:fs";
import { formatCliCommand } from "../../../cli/command-format.js";
import { resolveGatewayPort } from "../../../config/config.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  CODEX_REMOTE_TARGET_ENV,
  resolveCodexDaemonCommand,
} from "../../../gateway/remote-access-health.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  enableTailscaleServe,
  readTailscaleWhoisIdentity,
  resolveTailscaleClient,
  tailscaleClientArgs,
  tailscaleFunnelStatusCoversPort,
  verifyTailscaleServeRoute,
  type ResolvedTailscaleClient,
} from "../../../infra/tailscale.js";
import { runExec } from "../../../process/exec.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../../shared/string-coerce.js";

const APP_STORE_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const HOMEBREW_TAILSCALE = "/opt/homebrew/bin/tailscale";
const INTEL_HOMEBREW_TAILSCALE = "/usr/local/bin/tailscale";

type Exec = typeof runExec;

type TailscaleDoctorScan = {
  needsTailscale: boolean;
  port: number;
  client?: ResolvedTailscaleClient;
  activeOrigin?: string;
  serveRouteOk?: boolean;
  funnelRouteOk?: boolean;
  warnings: string[];
};

function parseJsonObject(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function isTailscaleExposureMode(mode: unknown): mode is "serve" | "funnel" {
  return mode === "serve" || mode === "funnel";
}

function buildTailnetHttpsOrigin(host: string): string {
  const trimmed = host.trim().replace(/\.$/, "");
  const hostname = trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed}]` : trimmed;
  return `https://${hostname}`;
}

function allowedOriginsContain(cfg: OpenClawConfig, origin: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(origin);
  return (cfg.gateway?.controlUi?.allowedOrigins ?? []).some(
    (entry) => normalizeLowercaseStringOrEmpty(entry) === normalized,
  );
}

function isConfiguredSocketPath(cfg: OpenClawConfig, socketPath: string | undefined): boolean {
  const configured = normalizeOptionalString(cfg.gateway?.tailscale?.socketPath);
  return Boolean(socketPath && configured === socketPath);
}

function isConfiguredBinaryPath(cfg: OpenClawConfig, binaryPath: string | undefined): boolean {
  const configured = normalizeOptionalString(cfg.gateway?.tailscale?.binaryPath);
  return Boolean(binaryPath && configured === binaryPath);
}

async function listTailscaleInstallCandidates(params: {
  exec: Exec;
  env: NodeJS.ProcessEnv;
  fileExists: (path: string) => boolean;
}): Promise<string[]> {
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    const normalized = normalizeOptionalString(value);
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };
  try {
    const { stdout } = await params.exec("which", ["-a", "tailscale"], {
      timeoutMs: 2_000,
      maxBuffer: 50_000,
    });
    for (const line of stdout.split("\n")) {
      add(line);
    }
  } catch {
    // `which -a` is only a hint for diagnostics.
  }
  for (const path of [HOMEBREW_TAILSCALE, INTEL_HOMEBREW_TAILSCALE, APP_STORE_TAILSCALE]) {
    if (params.fileExists(path)) {
      add(path);
    }
  }
  return candidates;
}

function appendInstallWarnings(params: {
  cfg: OpenClawConfig;
  warnings: string[];
  installs: string[];
  client: ResolvedTailscaleClient;
}) {
  if (params.installs.length > 1 && !isConfiguredBinaryPath(params.cfg, params.client.binary)) {
    params.warnings.push(
      `- Tailscale: multiple CLI installs were found (${params.installs.join(", ")}). Pin gateway.tailscale.binaryPath or OPENCLAW_TAILSCALE_BIN so Gateway and doctor use the same install every time.`,
    );
  }
  if (params.client.installKind === "app-store") {
    params.warnings.push(
      "- Tailscale: the selected CLI is the Mac App Store app bundle. Install the standalone/Homebrew build and pin gateway.tailscale.binaryPath when Serve, whois, or SSH automation must be reliable.",
    );
  }
}

async function scanTailscaleGatewayAccess(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}): Promise<TailscaleDoctorScan> {
  const cfg = params.cfg;
  const env = params.env ?? process.env;
  const exec = params.exec ?? runExec;
  const fileExists = params.fileExists ?? existsSync;
  const mode = cfg.gateway?.tailscale?.mode;
  const allowTailscaleAuth = cfg.gateway?.auth?.allowTailscale === true;
  const needsTailscale = isTailscaleExposureMode(mode) || allowTailscaleAuth;
  const port = resolveGatewayPort(cfg, env);
  const warnings: string[] = [];
  if (!needsTailscale) {
    return { needsTailscale, port, warnings };
  }

  let client: ResolvedTailscaleClient;
  try {
    client = await resolveTailscaleClient(exec, {
      binaryPath: cfg.gateway?.tailscale?.binaryPath,
      socketPath: cfg.gateway?.tailscale?.socketPath,
      env,
    });
  } catch (err) {
    return {
      needsTailscale,
      port,
      warnings: [
        `- Tailscale: no usable daemon connection. ${formatErrorMessage(err)} Run ${formatCliCommand(
          "openclaw doctor --fix",
        )} after starting Tailscale, or set gateway.tailscale.binaryPath/socketPath explicitly.`,
      ],
    };
  }

  appendInstallWarnings({
    cfg,
    warnings,
    installs: await listTailscaleInstallCandidates({ exec, env, fileExists }),
    client,
  });
  if (client.warnings.length > 0) {
    warnings.push(
      `- Tailscale: selected ${client.binary}${
        client.socketPath ? ` with socket ${client.socketPath}` : ""
      } after earlier attempts failed: ${client.warnings.join("; ")}`,
    );
  }
  if (client.socketPath && !isConfiguredSocketPath(cfg, client.socketPath)) {
    warnings.push(
      `- Tailscale: daemon is reachable only through ${client.socketPath}; persist this with gateway.tailscale.socketPath or OPENCLAW_TAILSCALE_SOCKET so restarts do not fall back to a dead default socket.`,
    );
  }

  const activeHost = client.dnsName ?? client.ips[0];
  const activeOrigin = activeHost ? buildTailnetHttpsOrigin(activeHost) : undefined;
  if (
    isTailscaleExposureMode(mode) &&
    activeOrigin &&
    (cfg.gateway?.controlUi?.allowedOrigins?.length ?? 0) > 0 &&
    !allowedOriginsContain(cfg, activeOrigin)
  ) {
    warnings.push(
      `- Gateway/Tailscale: allowed origins do not include the active Serve origin ${activeOrigin}; stale hostnames can break browser/iPhone access after Tailscale node changes.`,
    );
  }

  let serveRouteOk: boolean | undefined;
  let funnelRouteOk: boolean | undefined;
  if (mode === "serve") {
    try {
      const { stdout } = await exec(
        client.binary,
        tailscaleClientArgs(client, ["serve", "status", "--json"]),
        { timeoutMs: 5_000, maxBuffer: 200_000 },
      );
      const verified = activeHost
        ? verifyTailscaleServeRoute(stdout ? parseJsonObject(stdout) : {}, {
            host: activeHost,
            port,
            path: "/",
          })
        : { ok: false, reason: "selected Tailscale client has no DNS name or IP" };
      serveRouteOk = verified.ok;
      if (!serveRouteOk) {
        warnings.push(
          `- Tailscale Serve: strict HTTPS 443 / route verification failed (${verified.reason ?? "unknown route mismatch"}). Gateway startup now fails when gateway.tailscale.required is true; run ${params.doctorFixCommand} to reapply the route.`,
        );
      }
    } catch (err) {
      serveRouteOk = false;
      warnings.push(`- Tailscale Serve: status check failed: ${formatErrorMessage(err)}`);
    }
  } else if (mode === "funnel") {
    try {
      const { stdout } = await exec(
        client.binary,
        tailscaleClientArgs(client, ["funnel", "status", "--json"]),
        { timeoutMs: 5_000, maxBuffer: 200_000 },
      );
      funnelRouteOk = tailscaleFunnelStatusCoversPort(stdout ? parseJsonObject(stdout) : {}, port);
      if (!funnelRouteOk) {
        warnings.push(
          `- Tailscale Funnel: no published route points at the Gateway port ${port}. Gateway startup now fails when gateway.tailscale.required is true.`,
        );
      }
    } catch (err) {
      funnelRouteOk = false;
      warnings.push(`- Tailscale Funnel: status check failed: ${formatErrorMessage(err)}`);
    }
  }

  if (allowTailscaleAuth) {
    const probeIp = client.ips[0];
    const whois = probeIp
      ? await readTailscaleWhoisIdentity(probeIp, exec, {
          binaryPath: client.binary,
          socketPath: client.socketPath,
          env,
          cacheTtlMs: 0,
          errorTtlMs: 0,
        })
      : null;
    if (!whois) {
      warnings.push(
        "- Gateway auth: gateway.auth.allowTailscale is enabled, but `tailscale whois` is unavailable through the selected daemon. Tailscale identity auth will be degraded until whois works on the same binary/socket.",
      );
    }
  }

  return {
    needsTailscale,
    port,
    client,
    activeOrigin,
    serveRouteOk,
    funnelRouteOk,
    warnings,
  };
}

export function parseSshConfigDump(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const [key, ...rest] = trimmed.split(/\s+/);
    if (!key || rest.length === 0) {
      continue;
    }
    out.set(key.toLowerCase(), rest.join(" "));
  }
  return out;
}

export function collectSshConfigHardeningWarnings(params: {
  target: string;
  config: Map<string, string>;
}): string[] {
  const target = normalizeLowercaseStringOrEmpty(params.target);
  const hostname = normalizeLowercaseStringOrEmpty(params.config.get("hostname"));
  const interval = Number.parseInt(params.config.get("serveraliveinterval") ?? "0", 10);
  const countMax = Number.parseInt(params.config.get("serveralivecountmax") ?? "0", 10);
  const controlMaster = normalizeLowercaseStringOrEmpty(params.config.get("controlmaster"));
  const controlPersist = normalizeLowercaseStringOrEmpty(params.config.get("controlpersist"));
  const warnings: string[] = [];

  if ((target.includes("openclaw") || target.includes("mac-studio")) && hostname === "github.com") {
    warnings.push(
      "- SSH: target resolves to github.com. This matches the earlier wildcard-routing failure; define a specific Host openclaw-studio/mac-studio-userspace block before broad GitHub rules.",
    );
  }

  const keepaliveWeak = !Number.isFinite(interval) || interval <= 0 || interval > 60;
  const countWeak = !Number.isFinite(countMax) || countMax < 3;
  const controlWeak =
    !["auto", "yes"].includes(controlMaster) || !controlPersist || controlPersist === "no";
  if (keepaliveWeak || countWeak || controlWeak) {
    warnings.push(
      [
        "- SSH: remote Codex target is missing durable keepalive/control settings.",
        "Recommended block:",
        "  ServerAliveInterval 30",
        "  ServerAliveCountMax 6",
        "  ControlMaster auto",
        "  ControlPersist 10m",
      ].join("\n"),
    );
  }

  return warnings;
}

async function collectRemoteCodexSshWarnings(params: {
  cfg: OpenClawConfig;
  exec: Exec;
  env: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const codexTarget =
    normalizeOptionalString(params.env[CODEX_REMOTE_TARGET_ENV]) ??
    normalizeOptionalString(params.cfg.gateway?.remote?.codexSshTarget);
  const gatewayRemoteTarget =
    params.cfg.gateway?.remote?.transport === "ssh"
      ? normalizeOptionalString(params.cfg.gateway.remote.sshTarget)
      : undefined;
  const inspectTarget = codexTarget ?? gatewayRemoteTarget;
  if (!inspectTarget) {
    return [];
  }
  const warnings: string[] = [];
  try {
    const { stdout } = await params.exec("/usr/bin/ssh", ["-G", "--", inspectTarget], {
      timeoutMs: 5_000,
      maxBuffer: 200_000,
    });
    warnings.push(
      ...collectSshConfigHardeningWarnings({
        target: inspectTarget,
        config: parseSshConfigDump(stdout),
      }),
    );
  } catch (err) {
    warnings.push(
      `- SSH: could not inspect config for ${inspectTarget}: ${formatErrorMessage(err)}`,
    );
  }

  if (!codexTarget) {
    return warnings;
  }

  const command = resolveCodexDaemonCommand(params.cfg, params.env);
  const identity = normalizeOptionalString(params.cfg.gateway?.remote?.sshIdentity);
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=6",
  ];
  if (identity) {
    args.push("-i", identity);
  }
  args.push("--", codexTarget, command);
  try {
    const { stdout } = await params.exec("/usr/bin/ssh", args, {
      timeoutMs: 10_000,
      maxBuffer: 200_000,
    });
    const parsed = parseJsonObject(stdout);
    if (parsed.status !== "running") {
      const status = typeof parsed.status === "string" ? parsed.status : "unknown";
      warnings.push(
        `- Codex remote SSH: app-server daemon check reached ${codexTarget}, but status was ${status}; expected "running".`,
      );
    }
  } catch (err) {
    warnings.push(
      `- Codex remote SSH: batch check failed for ${codexTarget}. Verify \`ssh ${codexTarget} '${command}'\` works without a password prompt. Error: ${formatErrorMessage(err)}`,
    );
  }
  return warnings;
}

export async function collectTailscaleRemoteHealthWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  fileExists?: (path: string) => boolean;
}): Promise<string[]> {
  const env = params.env ?? process.env;
  const exec = params.exec ?? runExec;
  const scan = await scanTailscaleGatewayAccess({ ...params, env, exec });
  return [
    ...scan.warnings,
    ...(await collectRemoteCodexSshWarnings({ cfg: params.cfg, env, exec })),
  ];
}

export async function maybeRepairTailscaleRemoteHealth(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  fileExists?: (path: string) => boolean;
}): Promise<{ config: OpenClawConfig; changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const exec = params.exec ?? runExec;
  const scan = await scanTailscaleGatewayAccess({ ...params, env, exec });
  let config = params.cfg;
  const changes: string[] = [];
  const repairWarnings: string[] = [];

  if (scan.client?.socketPath && !isConfiguredSocketPath(config, scan.client.socketPath)) {
    config = {
      ...config,
      gateway: {
        ...config.gateway,
        tailscale: {
          ...config.gateway?.tailscale,
          socketPath: scan.client.socketPath,
        },
      },
    };
    changes.push(`- gateway.tailscale.socketPath: set to ${scan.client.socketPath}`);
  }

  if (
    isTailscaleExposureMode(config.gateway?.tailscale?.mode) &&
    scan.activeOrigin &&
    !allowedOriginsContain(config, scan.activeOrigin)
  ) {
    config = {
      ...config,
      gateway: {
        ...config.gateway,
        controlUi: {
          ...config.gateway?.controlUi,
          allowedOrigins: [...(config.gateway?.controlUi?.allowedOrigins ?? []), scan.activeOrigin],
        },
      },
    };
    changes.push(
      `- gateway.controlUi.allowedOrigins: added active Tailscale origin ${scan.activeOrigin}`,
    );
  }

  if (config.gateway?.tailscale?.mode === "serve" && scan.client && scan.serveRouteOk === false) {
    try {
      await enableTailscaleServe(scan.port, exec, {
        binaryPath: scan.client.binary,
        socketPath: scan.client.socketPath,
        env,
      });
      changes.push(`- Tailscale Serve: reapplied HTTPS 443 route to http://127.0.0.1:${scan.port}`);
    } catch (err) {
      repairWarnings.push(`- Tailscale Serve: repair failed: ${formatErrorMessage(err)}`);
    }
  }

  const postScan =
    changes.length > 0 || repairWarnings.length > 0
      ? await scanTailscaleGatewayAccess({ ...params, cfg: config, env, exec })
      : scan;
  const warnings = [
    ...postScan.warnings,
    ...repairWarnings,
    ...(await collectRemoteCodexSshWarnings({ cfg: config, env, exec })),
  ];
  if (changes.length > 0) {
    warnings.push("- Gateway: restart the Gateway after doctor writes config repairs.");
  }
  return { config, changes, warnings };
}
