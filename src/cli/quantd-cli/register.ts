import type { Command } from "commander";
import { createQuantdClient, DEFAULT_QUANTD_BASE_URL } from "../../quantd/client.js";
import { resolveQuantdWalPath, startQuantdServer } from "../../quantd/server.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

function parsePort(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return fallback;
}

function parseMs(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed));
    }
  }
  return fallback;
}

function resolveClientOptions(opts: { url?: string; socket?: string }) {
  return {
    baseUrl: opts.socket ? undefined : (opts.url ?? DEFAULT_QUANTD_BASE_URL),
    socketPath: opts.socket?.trim() || undefined,
  };
}

export function registerQuantdCli(program: Command) {
  const quantd = program.command("quantd").description("Run and inspect the local quantd guard");

  quantd
    .command("run")
    .description("Run the quantd local guard daemon")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", "19891")
    .option("--socket <path>", "Unix socket path")
    .option("--wal <path>", "WAL file path")
    .option("--heartbeat-stale-ms <ms>", "Heartbeat stale threshold", "5000")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const started = await startQuantdServer({
          host: opts.host,
          port: parsePort(opts.port, 19_891),
          socketPath: opts.socket,
          walPath: resolveQuantdWalPath(opts.wal),
          heartbeatStaleAfterMs: parseMs(opts.heartbeatStaleMs, 5_000),
        });
        defaultRuntime.log(
          started.socketPath
            ? `quantd listening on socket ${started.socketPath}`
            : `quantd listening on ${started.baseUrl}`,
        );
        await new Promise<void>((resolve, reject) => {
          let stopping = false;
          const shutdown = () => {
            if (stopping) {
              return;
            }
            stopping = true;
            process.off("SIGINT", shutdown);
            process.off("SIGTERM", shutdown);
            void started.close().then(resolve, reject);
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        });
      });
    });

  quantd
    .command("health")
    .description("Read quantd health")
    .option("--url <url>", "quantd base URL", DEFAULT_QUANTD_BASE_URL)
    .option("--socket <path>", "Unix socket path")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const client = createQuantdClient(resolveClientOptions(opts));
        const health = await client.health();
        defaultRuntime.log(`status=${health.status} body=${health.body}`);
      });
    });

  quantd
    .command("snapshot")
    .description("Read quantd snapshot")
    .option("--url <url>", "quantd base URL", DEFAULT_QUANTD_BASE_URL)
    .option("--socket <path>", "Unix socket path")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const client = createQuantdClient(resolveClientOptions(opts));
        const snapshot = await client.snapshot();
        defaultRuntime.log(JSON.stringify(snapshot, null, 2));
      });
    });
}
