import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockChild = EventEmitter & {
  stderr?: EventEmitter & { setEncoding?: (enc: string) => void };
  kill: (signal?: NodeJS.Signals | number) => boolean;
  killed: boolean;
  pid?: number;
};

const tunnelServers: net.Server[] = [];

function parseLocalForwardPort(args: readonly string[]): number | null {
  const forwardIndex = args.indexOf("-L");
  const forward = forwardIndex >= 0 ? args[forwardIndex + 1] : undefined;
  if (typeof forward !== "string") {
    return null;
  }
  const port = Number.parseInt((forward.split(":")[0] ?? "").trim(), 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  const stderr = new EventEmitter() as MockChild["stderr"];
  stderr!.setEncoding = vi.fn();
  child.stderr = stderr;
  child.killed = false;
  child.pid = 4242;
  child.kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    child.killed = true;
    process.nextTick(() => {
      child.emit("exit", 0, null);
    });
    return true;
  });
  return child;
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (!addr || typeof addr === "string") {
          reject(new Error("failed to reserve a local port"));
          return;
        }
        resolve(addr.port);
      });
    });
  });
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const spawn = vi.fn((command: string, args: readonly string[]) => {
    const localPort = parseLocalForwardPort(args);
    if (localPort) {
      const server = net.createServer((socket) => {
        socket.end();
      });
      server.listen(localPort, "127.0.0.1");
      tunnelServers.push(server);
    }
    const child = createMockChild();
    return child as unknown as ChildProcess;
  });
  return { ...actual, spawn };
});

const spawnMock = vi.mocked(spawn);

afterEach(async () => {
  await Promise.all(
    tunnelServers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
  spawnMock.mockClear();
});

describe("ssh-tunnel", () => {
  it("spawns ssh via PATH for port forwards", async () => {
    const localPort = await reservePort();
    const { startSshPortForward } = await import("./ssh-tunnel.js");

    const tunnel = await startSshPortForward({
      target: "me@example.com:2222",
      localPortPreferred: localPort,
      remotePort: 18789,
      timeoutMs: 1200,
    });

    const command = spawnMock.mock.calls[0]?.[0];
    expect(command).toBe("ssh");
    await tunnel.stop();
  });
});
