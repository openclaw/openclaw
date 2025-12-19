#!/usr/bin/env node
import process from "node:process";

declare const __CLAWDIS_VERSION__: string;

const BUNDLED_VERSION =
  typeof __CLAWDIS_VERSION__ === "string" ? __CLAWDIS_VERSION__ : "0.0.0";

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

const args = process.argv.slice(2);

type GatewayWsLogStyle = "auto" | "full" | "compact";

async function main() {
  if (hasFlag(args, "--version") || hasFlag(args, "-v")) {
    // Match `clawdis --version` behavior for Swift env/version checks.
    // Keep output a single line.
    console.log(BUNDLED_VERSION);
    process.exit(0);
  }

  const [
    { loadConfig },
    { startGatewayServer },
    { setGatewayWsLogStyle },
    { setVerbose },
    { defaultRuntime },
  ] = await Promise.all([
    import("../config/config.js"),
    import("../gateway/server.js"),
    import("../gateway/ws-logging.js"),
    import("../globals.js"),
    import("../runtime.js"),
  ]);

  setVerbose(hasFlag(args, "--verbose"));

  const wsLogRaw = (
    hasFlag(args, "--compact") ? "compact" : argValue(args, "--ws-log")
  ) as string | undefined;
  const wsLogStyle: GatewayWsLogStyle =
    wsLogRaw === "compact" ? "compact" : wsLogRaw === "full" ? "full" : "auto";
  setGatewayWsLogStyle(wsLogStyle);

  const portRaw =
    argValue(args, "--port") ?? process.env.CLAWDIS_GATEWAY_PORT ?? "18789";
  const port = Number.parseInt(portRaw, 10);
  if (Number.isNaN(port) || port <= 0) {
    defaultRuntime.error(`Invalid --port (${portRaw})`);
    process.exit(1);
  }

  const cfg = loadConfig();
  const bindRaw =
    argValue(args, "--bind") ??
    process.env.CLAWDIS_GATEWAY_BIND ??
    cfg.gateway?.bind ??
    "loopback";
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
    process.exit(1);
  }

  const token = argValue(args, "--token");
  if (token) process.env.CLAWDIS_GATEWAY_TOKEN = token;

  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

  const shutdown = (signal: string) => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);

    if (shuttingDown) {
      defaultRuntime.log(
        `gateway: received ${signal} during shutdown; exiting now`,
      );
      process.exit(0);
    }
    shuttingDown = true;
    defaultRuntime.log(`gateway: received ${signal}; shutting down`);

    forceExitTimer = setTimeout(() => {
      defaultRuntime.error(
        "gateway: shutdown timed out; exiting without full cleanup",
      );
      process.exit(0);
    }, 5000);

    void (async () => {
      try {
        await server?.close();
      } catch (err) {
        defaultRuntime.error(`gateway: shutdown error: ${String(err)}`);
      } finally {
        if (forceExitTimer) clearTimeout(forceExitTimer);
        process.exit(0);
      }
    })();
  };

  const onSigterm = () => shutdown("SIGTERM");
  const onSigint = () => shutdown("SIGINT");

  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  try {
    server = await startGatewayServer(port, { bind });
  } catch (err) {
    defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
    process.exit(1);
  }

  // Keep process alive
  await new Promise<never>(() => {});
}

void main();
