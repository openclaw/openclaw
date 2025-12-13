import { spawn } from "node:child_process";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const waitForPortOpen = async (
  proc: ReturnType<typeof spawn>,
  chunksOut: string[],
  chunksErr: string[],
  port: number,
  timeoutMs: number,
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null) {
      const stdout = chunksOut.join("");
      const stderr = chunksErr.join("");
      throw new Error(
        `gateway exited before listening (code=${String(proc.exitCode)} signal=${String(proc.signalCode)})\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (err) => {
          socket.destroy();
          reject(err);
        });
      });
      return;
    } catch {
      // keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const stdout = chunksOut.join("");
  const stderr = chunksErr.join("");
  throw new Error(
    `timeout waiting for gateway to listen on port ${port}\n` +
      `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  );
};

const getFreePort = async () => {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("failed to bind ephemeral port");
  }
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return addr.port;
};

describe("gateway SIGTERM", () => {
  let child: ReturnType<typeof spawn> | null = null;

  afterEach(() => {
    if (!child || child.killed) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    child = null;
  });

  it("exits 0 on SIGTERM", { timeout: 30_000 }, async () => {
    const port = await getFreePort();
    const out: string[] = [];
    const err: string[] = [];

    child = spawn(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "gateway", "--port", String(port)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLAWDIS_SKIP_PROVIDERS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const proc = child;
    if (!proc) throw new Error("failed to spawn gateway");

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => out.push(String(d)));
    child.stderr?.on("data", (d) => err.push(String(d)));

    await waitForPortOpen(proc, out, err, port, 20_000);

    proc.kill("SIGTERM");

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      proc.once("exit", (code, signal) => resolve({ code, signal })),
    );

    if (result.code !== 0) {
      const stdout = out.join("");
      const stderr = err.join("");
      throw new Error(
        `expected exit code 0, got code=${String(result.code)} signal=${String(result.signal)}\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }
    expect(result.signal).toBeNull();
  });
});
