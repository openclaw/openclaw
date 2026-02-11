import type { Command } from "commander";
import fs from "node:fs";
import type { GatewayAuthMode } from "../../config/config.js";
import type { GatewayWsLogStyle } from "../../gateway/ws-logging.js";
import {
  CONFIG_PATH,
  loadConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
} from "../../config/config.js";
import {
  prepareSanitizedMounts,
  cleanupSanitizedMounts,
} from "../../config/prepare-sanitized-mounts.js";
import { resolveGatewayAuth } from "../../gateway/auth.js";
import { startGatewayServer } from "../../gateway/server.js";
import { setGatewayWsLogStyle } from "../../gateway/ws-logging.js";
import { setVerbose } from "../../globals.js";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { formatPortDiagnostics, inspectPortUsage } from "../../infra/ports.js";
import { setConsoleSubsystemFilter, setConsoleTimestampPrefix } from "../../logging/console.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import {
  startGatewayContainer,
  stopGatewayContainer,
  isGatewayContainerRunning,
  getGatewayContainerLogs,
} from "../../security/gateway-container.js";
import { startSecretsProxy, generateProxyAuthToken } from "../../security/secrets-proxy.js";
import { loadProxyPort } from "../../security/secrets-proxy-allowlist.js";
import { createSecretsRegistry } from "../../security/secrets-registry.js";
import { formatCliCommand } from "../command-format.js";
import { forceFreePortAndWait } from "../ports.js";
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
  secure?: boolean;
};

const gatewayLog = createSubsystemLogger("gateway");

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
  const passwordRaw = toOptionString(opts.password);
  const tokenRaw = toOptionString(opts.token);

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
  const resolvedAuth = resolveGatewayAuth({
    authConfig,
    env: process.env,
    tailscaleMode: tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off",
  });
  const resolvedAuthMode = resolvedAuth.mode;
  const tokenValue = resolvedAuth.token;
  const passwordValue = resolvedAuth.password;
  const hasToken = typeof tokenValue === "string" && tokenValue.trim().length > 0;
  const hasPassword = typeof passwordValue === "string" && passwordValue.trim().length > 0;
  const hasSharedSecret =
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

  try {
    if (opts.secure) {
      gatewayLog.info("Starting in SECURE mode (Docker + Secrets Proxy)");

      // NOTE: Do NOT set OPENCLAW_SECURE_MODE=1 here on the host process.
      // The host-side secrets proxy needs to resolve real tokens, not placeholders.
      // Only the Docker container should have OPENCLAW_SECURE_MODE=1 (set in gateway-container.ts).

      const proxyPort = loadProxyPort();

      // Initialize secrets registry (loads all credentials from host)
      gatewayLog.info("Loading secrets registry...");
      const registry = await createSecretsRegistry();
      gatewayLog.info(
        `Loaded ${registry.oauthProfiles.size} OAuth profiles, ${registry.apiKeys.size} API keys`,
      );

      // Start secrets proxy
      // Generate shared secret for proxy client auth
      const proxyAuthToken = generateProxyAuthToken();

      // Per-platform proxy binding:
      // - Linux/macOS: Unix socket (zero TCP exposure, filesystem ACL only)
      // - Windows: TCP on 127.0.0.1 (Docker Desktop can reach via host.docker.internal)
      const isWindows = process.platform === "win32";
      let proxySocketPath: string | undefined;

      let proxyServer: Awaited<ReturnType<typeof startSecretsProxy>>;
      try {
        if (isWindows) {
          proxyServer = await startSecretsProxy({
            port: proxyPort,
            bind: "127.0.0.1",
            registry,
            authToken: proxyAuthToken,
          });
          gatewayLog.info(`Secrets proxy started on 127.0.0.1:${proxyPort}`);
        } else {
          // Generate unique socket path for this session
          proxySocketPath = `/tmp/openclaw-proxy-${process.pid}.sock`;
          proxyServer = await startSecretsProxy({
            socketPath: proxySocketPath,
            registry,
            authToken: proxyAuthToken,
          });
          gatewayLog.info(`Secrets proxy started on socket: ${proxySocketPath}`);
        }
      } catch (err) {
        gatewayLog.error(`Failed to start secrets proxy: ${String(err)}`);
        defaultRuntime.exit(1);
        return;
      }

      // Prepare sanitized config files for mounting
      gatewayLog.info("Preparing sanitized config mounts...");
      let sanitizedMounts;
      try {
        sanitizedMounts = await prepareSanitizedMounts();
        gatewayLog.info(`Prepared ${sanitizedMounts.binds.length} bind mounts`);
      } catch (err) {
        gatewayLog.error(`Failed to prepare sanitized mounts: ${String(err)}`);
        proxyServer.close();
        defaultRuntime.exit(1);
        return;
      }

      // Start gateway container with sanitized mounts + network isolation
      let containerName: string;
      try {
        containerName = await startGatewayContainer({
          proxyPort,
          proxySocketPath,
          gatewayPort: port,
          env: { ...process.env, PROXY_AUTH_TOKEN: proxyAuthToken },
          binds: sanitizedMounts.binds,
        });
        gatewayLog.info(`Gateway container started: ${containerName}`);
      } catch (err) {
        gatewayLog.error(`Failed to start gateway container: ${String(err)}`);
        proxyServer.close();
        defaultRuntime.exit(1);
        return;
      }

      // P1 Fix: Wait for container to be ready with timeout
      const HEALTH_CHECK_INTERVAL = 1000;
      const HEALTH_CHECK_TIMEOUT = 30000;
      const startTime = Date.now();
      let containerReady = false;

      while (Date.now() - startTime < HEALTH_CHECK_TIMEOUT) {
        const isRunning = await isGatewayContainerRunning();
        if (isRunning) {
          containerReady = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL));
      }

      if (!containerReady) {
        gatewayLog.error("Gateway container failed to start within timeout");
        const logs = await getGatewayContainerLogs(20);
        gatewayLog.error(`Container logs:\n${logs}`);
        await stopGatewayContainer();
        proxyServer.close();
        defaultRuntime.exit(1);
        return;
      }

      gatewayLog.info("Gateway container is ready and healthy");

      // Set up graceful shutdown handlers
      const abortController = new AbortController();
      const shutdown = async () => {
        abortController.abort();
        gatewayLog.info("Shutting down secure gateway...");
        try {
          await stopGatewayContainer();
          gatewayLog.info("Gateway container stopped");
        } catch (err) {
          gatewayLog.error(`Error stopping container: ${String(err)}`);
        }
        try {
          proxyServer.close();
          gatewayLog.info("Secrets proxy stopped");
        } catch (err) {
          gatewayLog.error(`Error stopping proxy: ${String(err)}`);
        }
        // Cleanup sanitized mount files
        try {
          await cleanupSanitizedMounts(sanitizedMounts.sanitizedDir);
          gatewayLog.info("Sanitized mounts cleaned up");
        } catch (err) {
          gatewayLog.error(`Error cleaning up sanitized mounts: ${String(err)}`);
        }
      };

      // Handle shutdown signals - ensure cleanup completes before exit
      const handleShutdown = () => {
        void shutdown().then(() => defaultRuntime.exit(0));
      };

      process.on("SIGINT", handleShutdown);
      process.on("SIGTERM", handleShutdown);

      gatewayLog.info("Secure mode running. Press Ctrl+C to stop.");

      // P1 Fix: Monitor container health periodically
      const healthCheckLoop = async () => {
        while (!abortController.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 10000)); // Check every 10s
          if (abortController.signal.aborted) break;
          const isRunning = await isGatewayContainerRunning();
          if (!isRunning) {
            gatewayLog.error("Gateway container stopped unexpectedly");
            const logs = await getGatewayContainerLogs(50);
            gatewayLog.error(`Final container logs:\n${logs}`);
            await shutdown();
            return;
          }
        }
      };

      // Run health check loop (non-blocking)
      void healthCheckLoop();

      // Keep process alive
      await new Promise(() => {});
      return;
    }

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
    .option("--secure", "Run gateway inside a secure Docker container with secrets proxy", false)
    .action(async (opts) => {
      await runGatewayCommand(opts);
    });
}
