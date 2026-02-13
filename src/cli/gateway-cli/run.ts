import type { Command } from "commander";
import crypto from "node:crypto";
import fs from "node:fs";
import type { GatewayAuthMode, OpenClawConfig } from "../../config/config.js";
import type { GatewayWsLogStyle } from "../../gateway/ws-logging.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import { resolveConfiguredModelRef } from "../../agents/model-selection.js";
import {
  CONFIG_PATH,
  createConfigIO,
  loadConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
} from "../../config/config.js";
import { resolveGatewayAuth } from "../../gateway/auth.js";
import { startGatewayServer } from "../../gateway/server.js";
import { setGatewayWsLogStyle } from "../../gateway/ws-logging.js";
import { setVerbose } from "../../globals.js";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { formatPortDiagnostics, inspectPortUsage } from "../../infra/ports.js";
import { setConsoleSubsystemFilter, setConsoleTimestampPrefix } from "../../logging/console.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { forceFreePortAndWait } from "../ports.js";
import { promptYesNo } from "../prompt.js";
import { ensureDevGatewayConfig } from "./dev.js";
import { runGatewayLoop } from "./run-loop.js";
import {
  describeUnknownError,
  extractGatewayMiskeys,
  maybeExplainGatewayServiceStop,
  parsePort,
  toOptionString,
} from "./shared.js";

type GatewayRunOpts = {
  port?: unknown;
  bind?: unknown;
  token?: unknown;
  auth?: unknown;
  password?: unknown;
  tailscale?: unknown;
  tailscaleResetOnExit?: boolean;
  allowUnconfigured?: boolean;
  force?: boolean;
  verbose?: boolean;
  claudeCliLogs?: boolean;
  wsLog?: unknown;
  compact?: boolean;
  rawStream?: boolean;
  rawStreamPath?: unknown;
  dev?: boolean;
  reset?: boolean;
};

const gatewayLog = createSubsystemLogger("gateway");

function generateGatewaySecret(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function isMissingProviderCredentialError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /No API key found|No credentials found/i.test(message);
}

async function maybeLogMissingProviderAuth(cfg: OpenClawConfig): Promise<void> {
  const resolvedModel = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  try {
    await resolveApiKeyForProvider({
      provider: resolvedModel.provider,
      cfg,
    });
  } catch (err) {
    if (!isMissingProviderCredentialError(err)) {
      return;
    }
    const provider = resolvedModel.provider;
    const model = resolvedModel.model;
    const authCommand =
      provider === "anthropic"
        ? formatCliCommand("openclaw models auth setup-token --provider anthropic")
        : formatCliCommand(`openclaw models auth login --provider ${provider}`);
    defaultRuntime.log(
      [
        `Model auth missing for ${provider}/${model}.`,
        "OpenClaw requires two credentials to fully work:",
        "1) Gateway auth token/password (connect to the gateway)",
        "2) Provider auth (API key/OAuth/token) for model replies",
        `Configure provider auth: ${authCommand}`,
        `Verify readiness: ${formatCliCommand("openclaw models status --check")}`,
      ].join("\n"),
    );
  }
}

async function maybeBootstrapMissingGatewayAuth(params: {
  mode: GatewayAuthMode;
  allowedByTailscale: boolean;
  hasSecret: boolean;
}): Promise<string | null> {
  if (params.hasSecret || params.allowedByTailscale || !process.stdin.isTTY) {
    return null;
  }
  const secretLabel = params.mode === "password" ? "password" : "token";
  const ok = await promptYesNo(
    `Gateway auth ${secretLabel} is missing. Generate and save one now?`,
    true,
  );
  if (!ok) {
    return null;
  }
  const io = createConfigIO();
  const cfg = io.loadConfig();
  const secret = generateGatewaySecret();
  const next = {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      auth: {
        ...cfg.gateway?.auth,
        mode: params.mode,
        ...(params.mode === "token" ? { token: secret } : { password: secret }),
      },
    },
  };
  await io.writeConfigFile(next);
  defaultRuntime.log(`Generated gateway ${secretLabel} and saved to ${io.configPath}.`);
  return secret;
}

async function runGatewayCommand(opts: GatewayRunOpts) {
  const isDevProfile = process.env.OPENCLAW_PROFILE?.trim().toLowerCase() === "dev";
  const devMode = Boolean(opts.dev) || isDevProfile;
  if (opts.reset && !devMode) {
    defaultRuntime.error("Use --reset with --dev.");
    defaultRuntime.exit(1);
    return;
  }

  setConsoleTimestampPrefix(true);
  setVerbose(Boolean(opts.verbose));
  if (opts.claudeCliLogs) {
    setConsoleSubsystemFilter(["agent/claude-cli"]);
    process.env.OPENCLAW_CLAUDE_CLI_LOG_OUTPUT = "1";
  }
  const wsLogRaw = (opts.compact ? "compact" : opts.wsLog) as string | undefined;
  const wsLogStyle: GatewayWsLogStyle =
    wsLogRaw === "compact" ? "compact" : wsLogRaw === "full" ? "full" : "auto";
  if (
    wsLogRaw !== undefined &&
    wsLogRaw !== "auto" &&
    wsLogRaw !== "compact" &&
    wsLogRaw !== "full"
  ) {
    defaultRuntime.error('Invalid --ws-log (use "auto", "full", "compact")');
    defaultRuntime.exit(1);
  }
  setGatewayWsLogStyle(wsLogStyle);

  if (opts.rawStream) {
    process.env.OPENCLAW_RAW_STREAM = "1";
  }
  const rawStreamPath = toOptionString(opts.rawStreamPath);
  if (rawStreamPath) {
    process.env.OPENCLAW_RAW_STREAM_PATH = rawStreamPath;
  }

  if (devMode) {
    await ensureDevGatewayConfig({ reset: Boolean(opts.reset) });
  }

  const cfg = loadConfig();
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
  }
  if (opts.force) {
    try {
      const { killed, waitedMs, escalatedToSigkill } = await forceFreePortAndWait(port, {
        timeoutMs: 2000,
        intervalMs: 100,
        sigtermTimeoutMs: 700,
      });
      if (killed.length === 0) {
        gatewayLog.info(`force: no listeners on port ${port}`);
      } else {
        for (const proc of killed) {
          gatewayLog.info(
            `force: killed pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""} on port ${port}`,
          );
        }
        if (escalatedToSigkill) {
          gatewayLog.info(`force: escalated to SIGKILL while freeing port ${port}`);
        }
        if (waitedMs > 0) {
          gatewayLog.info(`force: waited ${waitedMs}ms for port ${port} to free`);
        }
      }
    } catch (err) {
      defaultRuntime.error(`Force: ${String(err)}`);
      defaultRuntime.exit(1);
      return;
    }
  }
  if (opts.token) {
    const token = toOptionString(opts.token);
    if (token) {
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
    }
  }
  const authModeRaw = toOptionString(opts.auth);
  const authMode: GatewayAuthMode | null =
    authModeRaw === "token" || authModeRaw === "password" ? authModeRaw : null;
  if (authModeRaw && !authMode) {
    defaultRuntime.error('Invalid --auth (use "token" or "password")');
    defaultRuntime.exit(1);
    return;
  }
  const tailscaleRaw = toOptionString(opts.tailscale);
  const tailscaleMode =
    tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
      ? tailscaleRaw
      : null;
  if (tailscaleRaw && !tailscaleMode) {
    defaultRuntime.error('Invalid --tailscale (use "off", "serve", or "funnel")');
    defaultRuntime.exit(1);
    return;
  }
  let passwordRaw = toOptionString(opts.password);
  let tokenRaw = toOptionString(opts.token);

  const snapshot = await readConfigFileSnapshot().catch(() => null);
  const configExists = snapshot?.exists ?? fs.existsSync(CONFIG_PATH);
  const mode = cfg.gateway?.mode;
  if (!opts.allowUnconfigured && mode !== "local") {
    if (!configExists) {
      defaultRuntime.error(
        `Missing config. Run \`${formatCliCommand("openclaw setup")}\` or set gateway.mode=local (or pass --allow-unconfigured).`,
      );
    } else {
      defaultRuntime.error(
        `Gateway start blocked: set gateway.mode=local (current: ${mode ?? "unset"}) or pass --allow-unconfigured.`,
      );
    }
    defaultRuntime.exit(1);
    return;
  }
  const bindRaw = toOptionString(opts.bind) ?? cfg.gateway?.bind ?? "loopback";
  const bind =
    bindRaw === "loopback" ||
    bindRaw === "lan" ||
    bindRaw === "auto" ||
    bindRaw === "custom" ||
    bindRaw === "tailnet"
      ? bindRaw
      : null;
  if (!bind) {
    defaultRuntime.error('Invalid --bind (use "loopback", "lan", "tailnet", "auto", or "custom")');
    defaultRuntime.exit(1);
    return;
  }

  const miskeys = extractGatewayMiskeys(snapshot?.parsed);
  const authConfig = {
    ...cfg.gateway?.auth,
    ...(authMode ? { mode: authMode } : {}),
    ...(passwordRaw ? { password: passwordRaw } : {}),
    ...(tokenRaw ? { token: tokenRaw } : {}),
  };
  let resolvedAuth = resolveGatewayAuth({
    authConfig,
    env: process.env,
    tailscaleMode: tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off",
  });
  let resolvedAuthMode = resolvedAuth.mode;
  let tokenValue = resolvedAuth.token;
  let passwordValue = resolvedAuth.password;
  let hasToken = typeof tokenValue === "string" && tokenValue.trim().length > 0;
  let hasPassword = typeof passwordValue === "string" && passwordValue.trim().length > 0;
  let hasSharedSecret =
    (resolvedAuthMode === "token" && hasToken) || (resolvedAuthMode === "password" && hasPassword);
  const authHints: string[] = [];
  if (miskeys.hasGatewayToken) {
    authHints.push('Found "gateway.token" in config. Use "gateway.auth.token" instead.');
  }
  if (miskeys.hasRemoteToken) {
    authHints.push(
      '"gateway.remote.token" is for remote CLI calls; it does not enable local gateway auth.',
    );
  }
  if (resolvedAuthMode === "token" && !hasToken) {
    const generated = await maybeBootstrapMissingGatewayAuth({
      mode: "token",
      allowedByTailscale: Boolean(resolvedAuth.allowTailscale),
      hasSecret: hasToken,
    });
    if (generated) {
      tokenRaw = generated;
      process.env.OPENCLAW_GATEWAY_TOKEN = generated;
    }
  } else if (resolvedAuthMode === "password" && !hasPassword) {
    const generated = await maybeBootstrapMissingGatewayAuth({
      mode: "password",
      allowedByTailscale: false,
      hasSecret: hasPassword,
    });
    if (generated) {
      passwordRaw = generated;
      process.env.OPENCLAW_GATEWAY_PASSWORD = generated;
    }
  }

  resolvedAuth = resolveGatewayAuth({
    authConfig: {
      ...cfg.gateway?.auth,
      ...(authMode ? { mode: authMode } : {}),
      ...(passwordRaw ? { password: passwordRaw } : {}),
      ...(tokenRaw ? { token: tokenRaw } : {}),
    },
    env: process.env,
    tailscaleMode: tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off",
  });
  resolvedAuthMode = resolvedAuth.mode;
  tokenValue = resolvedAuth.token;
  passwordValue = resolvedAuth.password;
  hasToken = typeof tokenValue === "string" && tokenValue.trim().length > 0;
  hasPassword = typeof passwordValue === "string" && passwordValue.trim().length > 0;
  hasSharedSecret =
    (resolvedAuthMode === "token" && hasToken) || (resolvedAuthMode === "password" && hasPassword);

  if (resolvedAuthMode === "token" && !hasToken && !resolvedAuth.allowTailscale) {
    defaultRuntime.error(
      [
        "Gateway auth is set to token, but no token is configured.",
        "Set gateway.auth.token (or OPENCLAW_GATEWAY_TOKEN), or pass --token.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }
  if (resolvedAuthMode === "password" && !hasPassword) {
    defaultRuntime.error(
      [
        "Gateway auth is set to password, but no password is configured.",
        "Set gateway.auth.password (or OPENCLAW_GATEWAY_PASSWORD), or pass --password.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }
  if (bind !== "loopback" && !hasSharedSecret) {
    defaultRuntime.error(
      [
        `Refusing to bind gateway to ${bind} without auth.`,
        "Set gateway.auth.token/password (or OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD) or pass --token/--password.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }

  await maybeLogMissingProviderAuth(cfg);

  try {
    await runGatewayLoop({
      runtime: defaultRuntime,
      start: async () =>
        await startGatewayServer(port, {
          bind,
          auth:
            authMode || passwordRaw || tokenRaw || authModeRaw
              ? {
                  mode: authMode ?? undefined,
                  token: tokenRaw,
                  password: passwordRaw,
                }
              : undefined,
          tailscale:
            tailscaleMode || opts.tailscaleResetOnExit
              ? {
                  mode: tailscaleMode ?? undefined,
                  resetOnExit: Boolean(opts.tailscaleResetOnExit),
                }
              : undefined,
        }),
    });
  } catch (err) {
    if (
      err instanceof GatewayLockError ||
      (err && typeof err === "object" && (err as { name?: string }).name === "GatewayLockError")
    ) {
      const errMessage = describeUnknownError(err);
      defaultRuntime.error(
        `Gateway failed to start: ${errMessage}\nIf the gateway is supervised, stop it with: ${formatCliCommand("openclaw gateway stop")}`,
      );
      try {
        const diagnostics = await inspectPortUsage(port);
        if (diagnostics.status === "busy") {
          for (const line of formatPortDiagnostics(diagnostics)) {
            defaultRuntime.error(line);
          }
        }
      } catch {
        // ignore diagnostics failures
      }
      await maybeExplainGatewayServiceStop();
      defaultRuntime.exit(1);
      return;
    }
    defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export function addGatewayRunCommand(cmd: Command): Command {
  return cmd
    .option("--port <port>", "Port for the gateway WebSocket")
    .option(
      "--bind <mode>",
      'Bind mode ("loopback"|"lan"|"tailnet"|"auto"|"custom"). Defaults to config gateway.bind (or loopback).',
    )
    .option(
      "--token <token>",
      "Shared token required in connect.params.auth.token (default: OPENCLAW_GATEWAY_TOKEN env if set)",
    )
    .option("--auth <mode>", 'Gateway auth mode ("token"|"password")')
    .option("--password <password>", "Password for auth mode=password")
    .option("--tailscale <mode>", 'Tailscale exposure mode ("off"|"serve"|"funnel")')
    .option(
      "--tailscale-reset-on-exit",
      "Reset Tailscale serve/funnel configuration on shutdown",
      false,
    )
    .option(
      "--allow-unconfigured",
      "Allow gateway start without gateway.mode=local in config",
      false,
    )
    .option("--dev", "Create a dev config + workspace if missing (no BOOTSTRAP.md)", false)
    .option(
      "--reset",
      "Reset dev config + credentials + sessions + workspace (requires --dev)",
      false,
    )
    .option("--force", "Kill any existing listener on the target port before starting", false)
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .option(
      "--claude-cli-logs",
      "Only show claude-cli logs in the console (includes stdout/stderr)",
      false,
    )
    .option("--ws-log <style>", 'WebSocket log style ("auto"|"full"|"compact")', "auto")
    .option("--compact", 'Alias for "--ws-log compact"', false)
    .option("--raw-stream", "Log raw model stream events to jsonl", false)
    .option("--raw-stream-path <path>", "Raw stream jsonl path")
    .action(async (opts) => {
      await runGatewayCommand(opts);
    });
}
