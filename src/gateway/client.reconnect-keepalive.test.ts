import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

type ReconnectChildProcess = ChildProcessByStdio<null, Readable, Readable>;

async function listenWebSocketServer(port = 0): Promise<WebSocketServer> {
  return await new Promise((resolve, reject) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port });
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function closeWebSocketServer(server: WebSocketServer | null): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function waitForConnection(server: WebSocketServer, timeoutMs: number): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for websocket connection after ${timeoutMs}ms`));
    }, timeoutMs);
    server.once("connection", (socket) => {
      clearTimeout(timeout);
      resolve(socket);
    });
    server.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function startReconnectChild(url: string): {
  child: ReconnectChildProcess;
  stdout: string[];
  stderr: string[];
} {
  const clientModuleUrl = new URL("./client.ts", import.meta.url).href;
  const script = `
    import { GatewayClient } from ${JSON.stringify(clientModuleUrl)};
    const url = process.argv[1]?.trim();
    if (!url) {
      throw new Error("missing gateway url");
    }
    const client = new GatewayClient({
      url,
      onConnectError: (err) => {
        console.error(\`connect-error:\${err.message}\`);
      },
      onClose: (code, reason) => {
        console.error(\`close:\${code}:\${reason}\`);
      },
    });
    client.start();
    // Match the long-running node-host lifecycle: the GatewayClient owns reconnect behavior.
    await new Promise(() => {});
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, url],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  return { child, stdout, stderr };
}

async function stopChildProcess(child: ReconnectChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function waitForReconnectConnection(params: {
  server: WebSocketServer;
  child: ReconnectChildProcess;
  stderr: string[];
  timeoutMs: number;
}): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          [
            `timed out waiting for reconnect after ${params.timeoutMs}ms`,
            params.stderr.join("").trim() ? `stderr:\n${params.stderr.join("")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    }, params.timeoutMs);

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          [
            `child exited before reconnect (code=${code ?? "null"}, signal=${signal ?? "null"})`,
            params.stderr.join("").trim() ? `stderr:\n${params.stderr.join("")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    };

    const onConnection = (socket: WebSocket) => {
      cleanup();
      resolve(socket);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      params.child.off("exit", onExit);
      params.server.off("connection", onConnection);
    };

    params.child.once("exit", onExit);
    params.server.once("connection", onConnection);
    params.server.once("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

const activeServers = new Set<WebSocketServer>();
const activeChildren = new Set<ReconnectChildProcess>();

afterEach(async () => {
  await Promise.all([...activeServers].map(async (server) => await closeWebSocketServer(server)));
  activeServers.clear();
  await Promise.all([...activeChildren].map(async (child) => await stopChildProcess(child)));
  activeChildren.clear();
});

describe("GatewayClient reconnect keepalive", () => {
  it("keeps a long-running client alive long enough to reconnect after close", async () => {
    const firstServer = await listenWebSocketServer();
    activeServers.add(firstServer);
    const address = firstServer.address();
    const port =
      typeof address === "object" && address
        ? address.port
        : (() => {
            throw new Error("missing websocket server address");
          })();

    // Use a real child process so an unref'd reconnect timer can let the event loop fall out.
    const { child, stderr } = startReconnectChild(`ws://127.0.0.1:${port}`);
    activeChildren.add(child);

    const firstSocket = await waitForConnection(firstServer, 4_000);
    firstSocket.close(1012, "service restart");
    await once(firstSocket, "close");
    await closeWebSocketServer(firstServer);
    activeServers.delete(firstServer);

    const secondServer = await listenWebSocketServer(port);
    activeServers.add(secondServer);
    const secondSocket = await waitForReconnectConnection({
      server: secondServer,
      child,
      stderr,
      timeoutMs: 4_000,
    });

    expect(child.exitCode).toBeNull();
    secondSocket.close(1000, "test complete");
  });
});
