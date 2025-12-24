import fs from "node:fs";

import type { Command } from "commander";
import { CONFIG_PATH_CLAWDIS, loadConfig } from "../config/config.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { startGatewayServer } from "../gateway/server.js";
import {
  type GatewayWsLogStyle,
  setGatewayWsLogStyle,
} from "../gateway/ws-logging.js";
import { setVerbose } from "../globals.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { createSubsystemLogger } from "../logging.js";
import { defaultRuntime } from "../runtime.js";
import { createDefaultDeps } from "./deps.js";
import { forceFreePortAndWait } from "./ports.js";

type GatewayRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  expectFinal?: boolean;
};

const gatewayLog = createSubsystemLogger("gateway");

const gatewayCallOpts = (cmd: Command) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL", "ws://127.0.0.1:18789")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--expect-final", "Wait for final response (agent)", false);

const callGatewayCli = async (
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
) =>
  callGateway({
    url: opts.url,
    token: opts.token,
    password: opts.password,
    method,
    params,
    expectFinal: Boolean(opts.expectFinal),
    timeoutMs: Number(opts.timeout ?? 10_000),
    clientName: "cli",
    mode: "cli",
  });

export function registerGatewayCli(program: Command) {
  program
    .command("gateway-daemon")
    .description("Run the WebSocket Gateway as a long-lived daemon")
    .option("--port <port>", "Port for the gateway WebSocket", "18789")
    .option(
      "--bind <mode>",
      'Bind mode ("loopback"|"tailnet"|"lan"|"auto"). Defaults to config gateway.bind (or loopback).',
    )
    .option(
      "--token <token>",
      "Shared token required in connect.params.auth.token (default: CLAWDIS_GATEWAY_TOKEN env if set)",
    )
    .option("--auth <mode>", 'Gateway auth mode ("token"|"password")')
    .option("--password <password>", "Password for auth mode=password")
    .option(
      "--tailscale <mode>",
      'Tailscale exposure mode ("off"|"serve"|"funnel")',
    )
    .option(
      "--tailscale-reset-on-exit",
      "Reset Tailscale serve/funnel configuration on shutdown",
      false,
    )
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .option(
      "--ws-log <style>",
      'WebSocket log style ("auto"|"full"|"compact")',
      "auto",
    )
    .option("--compact", 'Alias for "--ws-log compact"', false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const wsLogRaw = (opts.compact ? "compact" : opts.wsLog) as
        | string
        | undefined;
      const wsLogStyle: GatewayWsLogStyle =
        wsLogRaw === "compact"
          ? "compact"
          : wsLogRaw === "full"
            ? "full"
            : "auto";
      if (
        wsLogRaw !== undefined &&
        wsLogRaw !== "auto" &&
        wsLogRaw !== "compact" &&
        wsLogRaw !== "full"
      ) {
        defaultRuntime.error(
          'Invalid --ws-log (use "auto", "full", "compact")',
        );
        defaultRuntime.exit(1);
      }
      setGatewayWsLogStyle(wsLogStyle);

      const port = Number.parseInt(String(opts.port ?? "18789"), 10);
      if (Number.isNaN(port) || port <= 0) {
        defaultRuntime.error("Invalid port");
        defaultRuntime.exit(1);
        return;
      }
      if (opts.token) {
        process.env.CLAWDIS_GATEWAY_TOKEN = String(opts.token);
      }
      const authModeRaw = opts.auth ? String(opts.auth) : undefined;
      const authMode =
        authModeRaw === "token" || authModeRaw === "password"
          ? authModeRaw
          : null;
      if (authModeRaw && !authMode) {
        defaultRuntime.error('Invalid --auth (use "token" or "password")');
        defaultRuntime.exit(1);
        return;
      }
      const tailscaleRaw = opts.tailscale ? String(opts.tailscale) : undefined;
      const tailscaleMode =
        tailscaleRaw === "off" ||
        tailscaleRaw === "serve" ||
        tailscaleRaw === "funnel"
          ? tailscaleRaw
          : null;
      if (tailscaleRaw && !tailscaleMode) {
        defaultRuntime.error(
          'Invalid --tailscale (use "off", "serve", or "funnel")',
        );
        defaultRuntime.exit(1);
        return;
      }
      const cfg = loadConfig();
      const bindRaw = String(opts.bind ?? cfg.gateway?.bind ?? "loopback");
      const bind =
        bindRaw === "loopback" ||
        bindRaw === "tailnet" ||
        bindRaw === "lan" ||
        bindRaw === "auto"
          ? bindRaw
          : null;
      if (!bind) {
        defaultRuntime.error(
          'Invalid --bind (use "loopback", "tailnet", "lan", or "auto")',
        );
        defaultRuntime.exit(1);
        return;
      }

      let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
      let shuttingDown = false;
      let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

      const onSigterm = () => shutdown("SIGTERM");
      const onSigint = () => shutdown("SIGINT");

      const shutdown = (signal: string) => {
        process.removeListener("SIGTERM", onSigterm);
        process.removeListener("SIGINT", onSigint);

        if (shuttingDown) {
          gatewayLog.info(`received ${signal} during shutdown; exiting now`);
          defaultRuntime.exit(0);
        }
        shuttingDown = true;
        gatewayLog.info(`received ${signal}; shutting down`);

        forceExitTimer = setTimeout(() => {
          gatewayLog.error("shutdown timed out; exiting without full cleanup");
          defaultRuntime.exit(0);
        }, 5000);

        void (async () => {
          try {
            await server?.close();
          } catch (err) {
            gatewayLog.error(`shutdown error: ${String(err)}`);
          } finally {
            if (forceExitTimer) clearTimeout(forceExitTimer);
            defaultRuntime.exit(0);
          }
        })();
      };

      process.once("SIGTERM", onSigterm);
      process.once("SIGINT", onSigint);

      try {
        server = await startGatewayServer(port, {
          bind,
          auth:
            authMode || opts.password || authModeRaw
              ? {
                  mode: authMode ?? undefined,
                  password: opts.password ? String(opts.password) : undefined,
                }
              : undefined,
          tailscale:
            tailscaleMode || opts.tailscaleResetOnExit
              ? {
                  mode: tailscaleMode ?? undefined,
                  resetOnExit: Boolean(opts.tailscaleResetOnExit),
                }
              : undefined,
        });
      } catch (err) {
        if (err instanceof GatewayLockError) {
          defaultRuntime.error(`Gateway failed to start: ${err.message}`);
          defaultRuntime.exit(1);
          return;
        }
        defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
        defaultRuntime.exit(1);
      }

      await new Promise<never>(() => {});
    });

  const gateway = program
    .command("gateway")
    .description("Run the WebSocket Gateway")
    .option("--port <port>", "Port for the gateway WebSocket", "18789")
    .option(
      "--bind <mode>",
      'Bind mode ("loopback"|"tailnet"|"lan"|"auto"). Defaults to config gateway.bind (or loopback).',
    )
    .option(
      "--token <token>",
      "Shared token required in connect.params.auth.token (default: CLAWDIS_GATEWAY_TOKEN env if set)",
    )
    .option("--auth <mode>", 'Gateway auth mode ("token"|"password")')
    .option("--password <password>", "Password for auth mode=password")
    .option(
      "--tailscale <mode>",
      'Tailscale exposure mode ("off"|"serve"|"funnel")',
    )
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
    .option(
      "--force",
      "Kill any existing listener on the target port before starting",
      false,
    )
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .option(
      "--ws-log <style>",
      'WebSocket log style ("auto"|"full"|"compact")',
      "auto",
    )
    .option("--compact", 'Alias for "--ws-log compact"', false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const wsLogRaw = (opts.compact ? "compact" : opts.wsLog) as
        | string
        | undefined;
      const wsLogStyle: GatewayWsLogStyle =
        wsLogRaw === "compact"
          ? "compact"
          : wsLogRaw === "full"
            ? "full"
            : "auto";
      if (
        wsLogRaw !== undefined &&
        wsLogRaw !== "auto" &&
        wsLogRaw !== "compact" &&
        wsLogRaw !== "full"
      ) {
        defaultRuntime.error(
          'Invalid --ws-log (use "auto", "full", "compact")',
        );
        defaultRuntime.exit(1);
      }
      setGatewayWsLogStyle(wsLogStyle);

      const port = Number.parseInt(String(opts.port ?? "18789"), 10);
      if (Number.isNaN(port) || port <= 0) {
        defaultRuntime.error("Invalid port");
        defaultRuntime.exit(1);
      }
      if (opts.force) {
        try {
          const { killed, waitedMs, escalatedToSigkill } =
            await forceFreePortAndWait(port, {
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
              gatewayLog.info(
                `force: escalated to SIGKILL while freeing port ${port}`,
              );
            }
            if (waitedMs > 0) {
              gatewayLog.info(
                `force: waited ${waitedMs}ms for port ${port} to free`,
              );
            }
          }
        } catch (err) {
          defaultRuntime.error(`Force: ${String(err)}`);
          defaultRuntime.exit(1);
          return;
        }
      }
      if (opts.token) {
        process.env.CLAWDIS_GATEWAY_TOKEN = String(opts.token);
      }
      const authModeRaw = opts.auth ? String(opts.auth) : undefined;
      const authMode =
        authModeRaw === "token" || authModeRaw === "password"
          ? authModeRaw
          : null;
      if (authModeRaw && !authMode) {
        defaultRuntime.error('Invalid --auth (use "token" or "password")');
        defaultRuntime.exit(1);
        return;
      }
      const tailscaleRaw = opts.tailscale ? String(opts.tailscale) : undefined;
      const tailscaleMode =
        tailscaleRaw === "off" ||
        tailscaleRaw === "serve" ||
        tailscaleRaw === "funnel"
          ? tailscaleRaw
          : null;
      if (tailscaleRaw && !tailscaleMode) {
        defaultRuntime.error(
          'Invalid --tailscale (use "off", "serve", or "funnel")',
        );
        defaultRuntime.exit(1);
        return;
      }
      const cfg = loadConfig();
      const configExists = fs.existsSync(CONFIG_PATH_CLAWDIS);
      const mode = cfg.gateway?.mode;
      if (!opts.allowUnconfigured && mode !== "local") {
        if (!configExists) {
          defaultRuntime.error(
            "Missing config. Run `clawdis setup` or set gateway.mode=local (or pass --allow-unconfigured).",
          );
        } else {
          defaultRuntime.error(
            "Gateway start blocked: set gateway.mode=local (or pass --allow-unconfigured).",
          );
        }
        defaultRuntime.exit(1);
        return;
      }
      const bindRaw = String(opts.bind ?? cfg.gateway?.bind ?? "loopback");
      const bind =
        bindRaw === "loopback" ||
        bindRaw === "tailnet" ||
        bindRaw === "lan" ||
        bindRaw === "auto"
          ? bindRaw
          : null;
      if (!bind) {
        defaultRuntime.error(
          'Invalid --bind (use "loopback", "tailnet", "lan", or "auto")',
        );
        defaultRuntime.exit(1);
        return;
      }

      let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
      let shuttingDown = false;
      let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

      const onSigterm = () => shutdown("SIGTERM");
      const onSigint = () => shutdown("SIGINT");

      const shutdown = (signal: string) => {
        // Ensure we don't leak listeners across restarts/tests.
        process.removeListener("SIGTERM", onSigterm);
        process.removeListener("SIGINT", onSigint);

        if (shuttingDown) {
          gatewayLog.info(`received ${signal} during shutdown; exiting now`);
          defaultRuntime.exit(0);
        }
        shuttingDown = true;
        gatewayLog.info(`received ${signal}; shutting down`);

        // Avoid hanging forever if a provider task ignores abort.
        forceExitTimer = setTimeout(() => {
          gatewayLog.error("shutdown timed out; exiting without full cleanup");
          defaultRuntime.exit(0);
        }, 5000);

        void (async () => {
          try {
            await server?.close();
          } catch (err) {
            gatewayLog.error(`shutdown error: ${String(err)}`);
          } finally {
            if (forceExitTimer) clearTimeout(forceExitTimer);
            defaultRuntime.exit(0);
          }
        })();
      };

      process.once("SIGTERM", onSigterm);
      process.once("SIGINT", onSigint);

      try {
        server = await startGatewayServer(port, {
          bind,
          auth:
            authMode || opts.password || authModeRaw
              ? {
                  mode: authMode ?? undefined,
                  password: opts.password ? String(opts.password) : undefined,
                }
              : undefined,
          tailscale:
            tailscaleMode || opts.tailscaleResetOnExit
              ? {
                  mode: tailscaleMode ?? undefined,
                  resetOnExit: Boolean(opts.tailscaleResetOnExit),
                }
              : undefined,
        });
      } catch (err) {
        if (err instanceof GatewayLockError) {
          defaultRuntime.error(`Gateway failed to start: ${err.message}`);
          defaultRuntime.exit(1);
          return;
        }
        defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
        defaultRuntime.exit(1);
      }
      // Keep process alive
      await new Promise<never>(() => {});
    });

  gatewayCallOpts(
    gateway
      .command("call")
      .description("Call a Gateway method and print JSON")
      .argument(
        "<method>",
        "Method name (health/status/system-presence/send/agent/cron.*)",
      )
      .option("--params <json>", "JSON object string for params", "{}")
      .action(async (method, opts) => {
        try {
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callGatewayCli(method, opts, params);
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(`Gateway call failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("health")
      .description("Fetch Gateway health")
      .action(async (opts) => {
        try {
          const result = await callGatewayCli("health", opts);
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("status")
      .description("Fetch Gateway status")
      .action(async (opts) => {
        try {
          const result = await callGatewayCli("status", opts);
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("wake")
      .description("Enqueue a system event and optionally trigger a heartbeat")
      .requiredOption("--text <text>", "System event text")
      .option(
        "--mode <mode>",
        "Wake mode (now|next-heartbeat)",
        "next-heartbeat",
      )
      .action(async (opts) => {
        try {
          const result = await callGatewayCli("wake", opts, {
            mode: opts.mode,
            text: opts.text,
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("send")
      .description("Send a message via the Gateway")
      .requiredOption("--to <jidOrPhone>", "Destination (E.164 or jid)")
      .requiredOption("--message <text>", "Message text")
      .option("--media-url <url>", "Optional media URL")
      .option("--idempotency-key <key>", "Idempotency key")
      .action(async (opts) => {
        try {
          const idempotencyKey = opts.idempotencyKey ?? randomIdempotencyKey();
          const result = await callGatewayCli("send", opts, {
            to: opts.to,
            message: opts.message,
            mediaUrl: opts.mediaUrl,
            idempotencyKey,
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("agent")
      .description("Run an agent turn via the Gateway (waits for final)")
      .requiredOption("--message <text>", "User message")
      .option("--to <jidOrPhone>", "Destination")
      .option("--session-id <id>", "Session id")
      .option("--thinking <level>", "Thinking level")
      .option("--deliver", "Deliver response", false)
      .option("--timeout-seconds <n>", "Agent timeout seconds")
      .option("--idempotency-key <key>", "Idempotency key")
      .action(async (opts) => {
        try {
          const idempotencyKey = opts.idempotencyKey ?? randomIdempotencyKey();
          const result = await callGatewayCli(
            "agent",
            { ...opts, expectFinal: true },
            {
              message: opts.message,
              to: opts.to,
              sessionId: opts.sessionId,
              thinking: opts.thinking,
              deliver: Boolean(opts.deliver),
              timeout: opts.timeoutSeconds
                ? Number.parseInt(String(opts.timeoutSeconds), 10)
                : undefined,
              idempotencyKey,
            },
          );
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  // Build default deps (keeps parity with other commands; future-proofing).
  void createDefaultDeps();
}
