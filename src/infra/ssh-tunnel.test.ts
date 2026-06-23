// Covers SSH target parsing and tunnel startup preflight behavior.
import { EventEmitter } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensurePortAvailable: vi.fn<(port: number, host?: string) => Promise<void>>(),
  spawn: vi.fn(),
}));

vi.mock("./ports.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ports.js")>()),
  ensurePortAvailable: mocks.ensurePortAvailable,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

import { PortInUseError } from "./ports.js";
import { parseSshTarget, startSshPortForward } from "./ssh-tunnel.js";

describe("parseSshTarget", () => {
  it("parses user@host:port targets", () => {
    expect(parseSshTarget("me@example.com:2222")).toEqual({
      user: "me",
      host: "example.com",
      port: 2222,
    });
  });

  it("strips an ssh prefix and keeps the default port when missing", () => {
    expect(parseSshTarget(" ssh alice@example.com ")).toEqual({
      user: "alice",
      host: "example.com",
      port: 22,
    });
  });

  it("rejects invalid hosts and ports", () => {
    expect(parseSshTarget("")).toBeNull();
    expect(parseSshTarget("me@example.com:0")).toBeNull();
    expect(parseSshTarget("me@example.com:22abc")).toBeNull();
    expect(parseSshTarget("me@example.com:70000")).toBeNull();
    expect(parseSshTarget("me@example.com:not-a-port")).toBeNull();
    expect(parseSshTarget("-V")).toBeNull();
    expect(parseSshTarget("me@-badhost")).toBeNull();
    expect(parseSshTarget("-oProxyCommand=echo")).toBeNull();
  });

  it("rejects hostnames with stray leading or trailing colons", () => {
    // Default-port branch: the whole host part keeps the stray colon.
    expect(parseSshTarget("host:")).toBeNull();
    expect(parseSshTarget(":22")).toBeNull();
    expect(parseSshTarget("user@:22")).toBeNull();
    expect(parseSshTarget("user@host:")).toBeNull();
    // Explicit-port branch: the port split slices a stray colon into the host.
    expect(parseSshTarget("host::22")).toBeNull();
    expect(parseSshTarget(":host:22")).toBeNull();
  });
});

describe("startSshPortForward", () => {
  const openServers: net.Server[] = [];

  afterEach(async () => {
    while (openServers.length > 0) {
      const server = openServers.pop();
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
    }
    mocks.ensurePortAvailable.mockReset();
    mocks.spawn.mockReset();
  });

  // Fake ssh child that, when spawned, parses the -L forward spec and starts a
  // real IPv4-loopback listener on the chosen local port so waitForLocalListener
  // resolves without launching a real ssh process.
  function spawnFakeSshListening() {
    mocks.spawn.mockImplementation((_cmd: string, args: string[]) => {
      const forwardSpec = args[args.indexOf("-L") + 1] ?? "";
      const localPort = Number(forwardSpec.split(":")[1]);
      const server = net.createServer();
      server.on("error", () => {});
      openServers.push(server);
      server.listen(localPort, "127.0.0.1");

      const child = new EventEmitter() as EventEmitter & {
        killed: boolean;
        pid: number;
        stderr: EventEmitter & { setEncoding: (enc: string) => void };
        kill: (signal?: string) => boolean;
      };
      child.killed = false;
      child.pid = 4242;
      const stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
      stderr.setEncoding = () => {};
      child.stderr = stderr;
      child.kill = (signal?: string) => {
        child.killed = true;
        queueMicrotask(() => child.emit("exit", 0, signal ?? null));
        return true;
      };
      return child;
    });
  }

  function spawnFakeSshStartupError(error: Error) {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        killed: boolean;
        pid?: number;
        stderr: EventEmitter & { setEncoding: (enc: string) => void };
        kill: (signal?: string) => boolean;
      };
      child.killed = false;
      const stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
      stderr.setEncoding = () => {};
      child.stderr = stderr;
      child.kill = (signal?: string) => {
        child.killed = true;
        queueMicrotask(() => child.emit("exit", null, signal ?? null));
        return true;
      };
      queueMicrotask(() => child.emit("error", error));
      return child;
    });
  }

  it("rejects when the ssh process cannot be spawned", async () => {
    const startupError = Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" });
    mocks.ensurePortAvailable.mockResolvedValueOnce();
    spawnFakeSshStartupError(startupError);

    await expect(
      startSshPortForward({
        target: "me@example.com:2222",
        localPortPreferred: 43210,
        remotePort: 18789,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("spawn ssh ENOENT");
  });

  it("scopes the preferred-port preflight to the IPv4 loopback interface", async () => {
    const sentinel = new Error("stop before spawning ssh");
    mocks.ensurePortAvailable.mockRejectedValueOnce(sentinel);

    await expect(
      startSshPortForward({
        target: "me@example.com:2222",
        localPortPreferred: 43210,
        remotePort: 18789,
        timeoutMs: 250,
      }),
    ).rejects.toBe(sentinel);

    expect(mocks.ensurePortAvailable).toHaveBeenCalledWith(43210, "127.0.0.1");
  });

  it("falls back to an ephemeral port when the preferred port is in use", async () => {
    // ensurePortAvailable raises the domain PortInUseError (no errno `code`),
    // which the catch must treat as "busy" and route to pickEphemeralPort.
    // Reserve a real port so pickEphemeralPort (listen(0)) cannot hand the same
    // number back and make the assertion flaky.
    const occupied = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", () => {
        occupied.off("error", reject);
        resolve();
      });
    });
    openServers.push(occupied);
    const addr = occupied.address();
    if (!addr || typeof addr === "string") {
      throw new Error("failed to reserve preferred port");
    }
    const preferredPort = addr.port;

    mocks.ensurePortAvailable.mockRejectedValueOnce(new PortInUseError(preferredPort));
    spawnFakeSshListening();

    const tunnel = await startSshPortForward({
      target: "me@example.com:2222",
      localPortPreferred: preferredPort,
      remotePort: 18789,
      timeoutMs: 1000,
    });

    expect(tunnel.localPort).not.toBe(preferredPort);
    expect(tunnel.localPort).toBeGreaterThan(0);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["-L", `127.0.0.1:${tunnel.localPort}:127.0.0.1:18789`]),
      expect.anything(),
    );

    await tunnel.stop();
  });
});
