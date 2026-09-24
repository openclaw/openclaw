import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { expect, type TestContext } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";

export async function listenServer(
  skip: TestContext["skip"],
  server: net.Server,
  port: number,
  host?: string,
): Promise<net.AddressInfo> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (host) {
        server.listen(port, host, resolve);
        return;
      }
      server.listen(port, resolve);
    });
  } catch (err) {
    const code = extractErrorCode(err);
    if (code === "EPERM" || code === "EACCES" || code === "EADDRNOTAVAIL") {
      skip(`TCP listener bind unavailable: ${code}`);
    }
    throw err;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected tcp address");
  }
  return address;
}

export async function withNativeSsConnection(
  skip: TestContext["skip"],
  inspect: (fixture: {
    port: number;
    clientPort: number;
    pid: number;
    stdout: string;
  }) => Promise<void>,
): Promise<void> {
  const accepted = createDeferred<net.Socket>();
  const sockets = new Set<net.Socket>();
  await using server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    accepted.resolve(socket);
  });
  const readiness = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const { port } = await listenServer(skip, server, 0, "127.0.0.1");
    child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
        import net from "node:net";
        const port = Number(process.argv[1]);
        process.title = "node worker:1";
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => process.send("ready"));
        socket.once("error", (error) => {
          process.send(error.code ?? "UNKNOWN", () => process.exit(1));
        });
        process.once("disconnect", () => socket.destroy());
      `,
        String(port),
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"], timeout: 20_000, killSignal: "SIGKILL" },
    );
    const [message]: unknown[] = await withTestTimeout(
      Promise.race([
        once(child, "message", { signal: readiness.signal }),
        once(child, "exit", { signal: readiness.signal }).then(([code, signal]) => {
          throw new Error(`TCP fixture exited before readiness: ${code}/${signal}`);
        }),
      ]),
      5_000,
      "TCP fixture did not report readiness",
    );
    readiness.abort();
    if (message !== "ready") {
      throw Object.assign(new Error(`TCP fixture connection failed: ${String(message)}`), {
        code: message,
      });
    }
    const socket = await withTestTimeout(accepted.promise, 5_000, "TCP fixture was not accepted");
    const clientPort = socket.remotePort;
    const pid = child.pid;
    if (clientPort === undefined || pid === undefined) {
      throw new Error("Native TCP fixture has no client port or child PID");
    }
    expect(socket.remoteAddress).toBe("127.0.0.1");
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    const captured = spawnSync(
      "ss",
      ["-H", "-tnp", "state", "established", `( sport = :${port} or dport = :${port} )`],
      { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
    );
    if (captured.error) {
      throw captured.error;
    }
    if (/operation not permitted|permission denied/i.test(captured.stderr)) {
      skip(`Native ss capture unavailable: ${captured.stderr.trim()}`);
    }
    if (captured.status !== 0) {
      throw new Error(`Native ss exited ${captured.status}: ${captured.stderr.trim()}`);
    }
    const clientRow = captured.stdout
      .split(/\r?\n/)
      .find((line) =>
        new RegExp(`\\b127\\.0\\.0\\.1:${clientPort}\\s+127\\.0\\.0\\.1:${port}(?:\\s|$)`).test(
          line,
        ),
      );
    expect(clientRow, "ss must capture the owned established client").toBeDefined();
    if (clientRow && !clientRow.includes("users:")) {
      skip("Native ss cannot expose process metadata for the owned client");
    }
    expect(clientRow).toMatch(new RegExp(`users:\\(\\("node worker:1",pid=${pid},fd=\\d+\\)`));

    await inspect({ port, clientPort, pid, stdout: captured.stdout });
  } catch (error) {
    const code = extractErrorCode(error);
    if (code && ["ENOENT", "EACCES", "EPERM", "EADDRNOTAVAIL"].includes(code)) {
      skip(`Native TCP/ss fixture unavailable: ${code}`);
    }
    throw error;
  } finally {
    readiness.abort();
    try {
      if (child?.pid !== undefined) {
        await stopChildProcess(child, 5_000);
      }
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
    }
  }
}
