import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import type { TestContext } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";

type NativeConnection = { port: number; clientPort: number; pid: number; stdout: string };

export async function listenServer(
  skip: TestContext["skip"],
  server: net.Server,
  port: number,
  host?: string,
): Promise<net.AddressInfo> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port, host }, resolve);
    });
  } catch (err) {
    const code = extractErrorCode(err);
    if (code === "EPERM" || code === "EACCES" || code === "EADDRNOTAVAIL") {
      skip(`TCP listener bind unavailable: ${code}`);
    }
    throw err;
  }

  const address = server.address();
  assert(address && typeof address !== "string", "expected tcp address");
  return address;
}

export async function withNativeSsConnection(
  { skip, signal }: Pick<TestContext, "skip" | "signal">,
  inspect: (fixture: NativeConnection) => Promise<void>,
): Promise<void> {
  const accepted = createDeferred<net.Socket>();
  let socket: net.Socket | undefined;
  await using server = net.createServer((connected) => {
    socket = connected;
    accepted.resolve(connected);
  });
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown[]> | undefined;
  try {
    const { port } = await listenServer(skip, server, 0, "127.0.0.1");
    child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
        import net from "node:net";
        process.title = "node worker:1";
        const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[1]) });
        socket.once("connect", () => process.send("ready"));
        socket.once("error", (error) => process.send(error.code ?? "UNKNOWN", () => process.exit(1)));
        process.once("disconnect", () => socket.destroy());
      `,
        String(port),
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const childClosed = (closed = once(child, "close"));
    const wait = <T>(gate: PromiseLike<T>, message: string) =>
      withinTest(awaitGateBeforeSettlement(gate, childClosed, message), signal);
    const [message]: unknown[] = await wait(
      once(child, "message"),
      "TCP fixture did not report readiness",
    );
    if (message !== "ready") {
      throw Object.assign(new Error(`TCP fixture connection failed: ${String(message)}`), {
        code: message,
      });
    }
    const clientPort = (await wait(accepted.promise, "TCP fixture was not accepted")).remotePort;
    const pid = child.pid;
    assert(
      clientPort !== undefined && pid !== undefined,
      "Native TCP fixture needs a port and PID",
    );

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
    const clientEndpoint = new RegExp(
      `\\b127\\.0\\.0\\.1:${clientPort}\\s+127\\.0\\.0\\.1:${port}(?:\\s|$)`,
    );
    const clientRow = captured.stdout.split(/\r?\n/).find((line) => clientEndpoint.test(line));
    if (clientRow && !clientRow.includes("users:")) {
      skip("Native ss cannot expose process metadata for the owned client");
    }

    await withinTest(inspect({ port, clientPort, pid, stdout: captured.stdout }), signal);
  } catch (error) {
    const code = extractErrorCode(error);
    if (code && ["ENOENT", "EACCES", "EPERM", "EADDRNOTAVAIL"].includes(code)) {
      skip(`Native TCP/ss fixture unavailable: ${code}`);
    }
    throw error;
  } finally {
    try {
      if (child?.pid !== undefined) {
        child.kill("SIGTERM");
        await closed;
      }
    } finally {
      socket?.destroy();
    }
  }
}
