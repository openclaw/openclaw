import { formatCliCommand } from "../cli/command-format.js";
import type { GatewayRemoteAccessHealthSummary } from "../commands/health.types.js";
import { resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  readTailscaleWhoisIdentity,
  resolveTailscaleClient,
  tailscaleClientArgs,
  tailscaleFunnelStatusCoversPort,
  verifyTailscaleServeRoute,
} from "../infra/tailscale.js";
import { runExec } from "../process/exec.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export const CODEX_REMOTE_TARGET_ENV = "OPENCLAW_CODEX_REMOTE_SSH_TARGET";
export const CODEX_REMOTE_COMMAND_ENV = "OPENCLAW_CODEX_REMOTE_DAEMON_COMMAND";
export const DEFAULT_CODEX_REMOTE_COMMAND =
  "$HOME/.codex/packages/standalone/current/codex app-server daemon version";

type Exec = typeof runExec;

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

function parseSshConfigDump(stdout: string): Map<string, string> {
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

function collectSshConfigReasons(target: string, config: Map<string, string>): string[] {
  const normalizedTarget = normalizeLowercaseStringOrEmpty(target);
  const hostname = normalizeLowercaseStringOrEmpty(config.get("hostname"));
  const interval = Number.parseInt(config.get("serveraliveinterval") ?? "0", 10);
  const countMax = Number.parseInt(config.get("serveralivecountmax") ?? "0", 10);
  const controlMaster = normalizeLowercaseStringOrEmpty(config.get("controlmaster"));
  const controlPersist = normalizeLowercaseStringOrEmpty(config.get("controlpersist"));
  const reasons: string[] = [];

  if (
    (normalizedTarget.includes("openclaw") || normalizedTarget.includes("mac-studio")) &&
    hostname === "github.com"
  ) {
    reasons.push(
      `SSH target ${target} resolves to github.com; put a specific Host block before broad GitHub rules.`,
    );
  }
  if (!Number.isFinite(interval) || interval <= 0 || interval > 60) {
    reasons.push(`SSH target ${target} is missing ServerAliveInterval <= 60.`);
  }
  if (!Number.isFinite(countMax) || countMax < 3) {
    reasons.push(`SSH target ${target} is missing ServerAliveCountMax >= 3.`);
  }
  if (!["auto", "yes"].includes(controlMaster) || !controlPersist || controlPersist === "no") {
    reasons.push(`SSH target ${target} is missing ControlMaster/ControlPersist hardening.`);
  }
  return reasons;
}

function resolveCodexSshTarget(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string | undefined {
  return (
    normalizeOptionalString(env[CODEX_REMOTE_TARGET_ENV]) ??
    normalizeOptionalString(cfg.gateway?.remote?.codexSshTarget)
  );
}

export function resolveCodexDaemonCommand(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string {
  return (
    normalizeOptionalString(env[CODEX_REMOTE_COMMAND_ENV]) ??
    normalizeOptionalString(cfg.gateway?.remote?.codexDaemonCommand) ??
    DEFAULT_CODEX_REMOTE_COMMAND
  );
}

function pushUnique(values: string[], value: string) {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function finalizeRemoteAccessHealth(
  summary: GatewayRemoteAccessHealthSummary,
): GatewayRemoteAccessHealthSummary {
  if (summary.degradedReasons.length === 0) {
    summary.status = "healthy";
  } else {
    summary.status = summary.required ? "failed" : "degraded";
  }
  return summary;
}

async function collectCodexSshHealth(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  exec: Exec;
  summary: GatewayRemoteAccessHealthSummary;
}) {
  const target = resolveCodexSshTarget(params.cfg, params.env);
  if (!target) {
    return;
  }
  const command = resolveCodexDaemonCommand(params.cfg, params.env);
  params.summary.required = true;
  params.summary.codexSsh = { target, configOk: true };
  pushUnique(params.summary.repairCommands, formatCliCommand("openclaw doctor --fix"));

  try {
    const { stdout } = await params.exec("/usr/bin/ssh", ["-G", "--", target], {
      timeoutMs: 5_000,
      maxBuffer: 200_000,
    });
    const reasons = collectSshConfigReasons(target, parseSshConfigDump(stdout));
    if (reasons.length > 0) {
      params.summary.codexSsh.configOk = false;
      params.summary.degradedReasons.push(...reasons);
    }
  } catch (err) {
    params.summary.codexSsh.configOk = false;
    params.summary.degradedReasons.push(
      `SSH config inspection failed for ${target}: ${formatErrorMessage(err)}`,
    );
  }

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
  const identity = normalizeOptionalString(params.cfg.gateway?.remote?.sshIdentity);
  if (identity) {
    args.push("-i", identity);
  }
  args.push("--", target, command);

  try {
    const { stdout } = await params.exec("/usr/bin/ssh", args, {
      timeoutMs: 10_000,
      maxBuffer: 200_000,
    });
    const parsed = parseJsonObject(stdout);
    const status = typeof parsed.status === "string" ? parsed.status : undefined;
    params.summary.codexSsh.batchOk = true;
    params.summary.codexSsh.daemonStatus = status;
    if (typeof parsed.cliVersion === "string") {
      params.summary.codexSsh.cliVersion = parsed.cliVersion;
    }
    if (typeof parsed.appServerVersion === "string") {
      params.summary.codexSsh.appServerVersion = parsed.appServerVersion;
    }
    if (status !== "running") {
      params.summary.degradedReasons.push(
        `Codex app-server daemon check reached ${target}, but status was ${status ?? "unknown"}.`,
      );
    }
  } catch (err) {
    params.summary.codexSsh.batchOk = false;
    params.summary.degradedReasons.push(
      `Codex app-server daemon check failed for ${target}: ${formatErrorMessage(err)}`,
    );
  }
}

export async function buildGatewayRemoteAccessHealth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
}): Promise<GatewayRemoteAccessHealthSummary | undefined> {
  const env = params.env ?? process.env;
  const exec = params.exec ?? runExec;
  const cfg = params.cfg;
  const mode = cfg.gateway?.tailscale?.mode ?? "off";
  const allowTailscaleAuth = cfg.gateway?.auth?.allowTailscale === true;
  const codexTarget = resolveCodexSshTarget(cfg, env);
  const needsTailscale = isTailscaleExposureMode(mode) || allowTailscaleAuth;
  if (!needsTailscale && !codexTarget) {
    return undefined;
  }

  const summary: GatewayRemoteAccessHealthSummary = {
    status: "healthy",
    required:
      (isTailscaleExposureMode(mode) ? (cfg.gateway?.tailscale?.required ?? true) : false) ||
      allowTailscaleAuth ||
      Boolean(codexTarget),
    degradedReasons: [],
    repairCommands: [],
  };
  pushUnique(summary.repairCommands, formatCliCommand("openclaw doctor --fix"));

  if (needsTailscale) {
    summary.tailscale = { mode };
    const port = resolveGatewayPort(cfg, env);
    try {
      const client = await resolveTailscaleClient(exec, {
        binaryPath: cfg.gateway?.tailscale?.binaryPath,
        socketPath: cfg.gateway?.tailscale?.socketPath,
        env,
      });
      summary.tailscale.binary = client.binary;
      summary.tailscale.socketPath = client.socketPath;
      summary.tailscale.backendState = client.backendState;
      summary.tailscale.dnsName = client.dnsName;
      summary.tailscale.ips = client.ips;
      summary.tailscale.installKind = client.installKind;
      if (client.warnings.length > 0) {
        summary.degradedReasons.push(
          `Tailscale selected ${client.binary}${
            client.socketPath ? ` with socket ${client.socketPath}` : ""
          } after failed attempts: ${client.warnings.join("; ")}`,
        );
      }
      if (client.installKind === "app-store" && isTailscaleExposureMode(mode)) {
        summary.degradedReasons.push(
          "Tailscale App Store build is selected for remote exposure; install/pin standalone or Homebrew Tailscale for Serve/Funnel automation.",
        );
      }

      if (mode === "serve") {
        try {
          const { stdout } = await exec(
            client.binary,
            tailscaleClientArgs(client, ["serve", "status", "--json"]),
            { timeoutMs: 5_000, maxBuffer: 200_000 },
          );
          const host = client.dnsName ?? client.ips[0];
          const verified = host
            ? verifyTailscaleServeRoute(stdout ? parseJsonObject(stdout) : {}, {
                host,
                port,
                path: "/",
              })
            : { ok: false, reason: "selected Tailscale client has no DNS name or IP" };
          summary.tailscale.serveRouteOk = verified.ok;
          if (!verified.ok) {
            summary.degradedReasons.push(
              `Tailscale Serve route mismatch: ${verified.reason ?? "unknown mismatch"}.`,
            );
          }
        } catch (err) {
          summary.tailscale.serveRouteOk = false;
          summary.degradedReasons.push(
            `Tailscale Serve status check failed: ${formatErrorMessage(err)}`,
          );
        }
      } else if (mode === "funnel") {
        try {
          const { stdout } = await exec(
            client.binary,
            tailscaleClientArgs(client, ["funnel", "status", "--json"]),
            { timeoutMs: 5_000, maxBuffer: 200_000 },
          );
          const ok = tailscaleFunnelStatusCoversPort(stdout ? parseJsonObject(stdout) : {}, port);
          summary.tailscale.funnelRouteOk = ok;
          if (!ok) {
            summary.degradedReasons.push(
              `Tailscale Funnel route mismatch: no published route points at Gateway port ${port}.`,
            );
          }
        } catch (err) {
          summary.tailscale.funnelRouteOk = false;
          summary.degradedReasons.push(
            `Tailscale Funnel status check failed: ${formatErrorMessage(err)}`,
          );
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
        summary.tailscale.whoisOk = Boolean(whois);
        if (!whois) {
          summary.degradedReasons.push(
            "Tailscale identity auth is enabled, but `tailscale whois` is unavailable through the selected binary/socket.",
          );
        }
      }
    } catch (err) {
      summary.tailscale.backendState = "Unknown";
      summary.degradedReasons.push(`Tailscale client unavailable: ${formatErrorMessage(err)}`);
    }
  }

  await collectCodexSshHealth({ cfg, env, exec, summary });
  return finalizeRemoteAccessHealth(summary);
}
