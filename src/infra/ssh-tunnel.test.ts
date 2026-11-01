import { EventEmitter } from "node:events";
import net from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  ensurePortAvailable: vi.fn<(port: number, host?: string) => Promise<void>>(),
  inspectPortUsage: vi.fn<typeof import("./ports-inspect.js").inspectPortUsage>(),
  resolveSshClient: vi.fn<() => string | null>(() => "/usr/bin/ssh"),
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

vi.mock("./ssh-client.js", () => ({
  resolveSshClient: mocks.resolveSshClient,
}));

vi.mock("./ports-inspect.js", () => ({
  inspectPortUsage: mocks.inspectPortUsage,
}));

import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import type { PortUsage } from "./ports-types.js";
import { PortInUseError } from "./ports.js";
import { parseSshTarget, startSshPortForward } from "./ssh-tunnel.js";

function syntheticChild(event = "exit", code = 0, killResult = true) {
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    pid: 4242,
    stderr: new PassThrough(),
    kill: vi.fn((signal?: string) => {
      child.killed = true;
      queueMicrotask(() => child.emit(event, code, signal ?? null));
      return killResult;
    }),
  });
  return child;
}

const spawnedChild = () => mocks.spawn.mock.results[0]?.value as ReturnType<typeof syntheticChild>;
const busyPort = (
  port: number,
  listeners: PortUsage["listeners"] = [{ pid: 4242 }],
): PortUsage => ({ port, status: "busy", listeners, hints: [] });

describe("parseSshTarget", () => {
  it("parses OpenSSH tokens and refuses invalid ports or config injection", () => {
    const cases: [string, ReturnType<typeof parseSshTarget>][] = [
      ["me@example.com:2222", { user: "me", host: "example.com", port: 2222 }],
      [" ssh alice@example.com ", { user: "alice", host: "example.com", port: 22 }],
      ["me+prod@prod+gpu:2222", { user: "me+prod", host: "prod+gpu", port: 2222 }],
      [
        String.raw`DOMAIN\alice@jump+gpu`,
        { user: String.raw`DOMAIN\alice`, host: "jump+gpu", port: 22 },
      ],
      ...[
        "",
        "me@example.com:0",
        "me@example.com:22abc",
        "me@example.com:70000",
        "me@example.com:not-a-port",
        "-V",
        "me@-badhost",
        "-oProxyCommand=touch@example.com",
        "-oProxyCommand=echo",
        "example.com\n  ProxyCommand touch marker",
        "example.com\r  ProxyCommand touch marker",
        "example.com\n  ProxyCommand touch marker:2222",
        "me\nProxyCommand=touch@example.com",
        "bad host",
        "me name@example.com",
        "host:",
        ":22",
        "user@:22",
        "user@host:",
        "host::22",
        ":host:22",
      ].map((target): [string, null] => [target, null]),
    ];
    for (const [target, expected] of cases) {
      expect(parseSshTarget(target), target).toEqual(expected);
    }
  });
});

describe("startSshPortForward", () => {
  const openServers: net.Server[] = [];
  const portClaims: TestPortClaim[] = [];
  const cleanups: (() => void | Promise<void>)[] = [];

  async function getClaimedPort(): Promise<number> {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    portClaims.push(claim);
    return claim.port;
  }

  async function listenOnPort(port = 0): Promise<number> {
    const server = net.createServer();
    openServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to reserve preferred port");
    }
    return address.port;
  }

  function startTunnel(
    localPortPreferred: number,
    options: Partial<Parameters<typeof startSshPortForward>[0]> = {},
  ) {
    return startSshPortForward({
      target: "me@example.com:2222",
      remotePort: 18789,
      timeoutMs: 1000,
      localPortPreferred,
      ...options,
    });
  }

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
    while (openServers.length > 0) {
      const server = openServers.pop();
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
    }
    await Promise.all(portClaims.splice(0).map((claim) => claim.release()));
    mocks.ensurePortAvailable.mockReset();
    mocks.inspectPortUsage.mockReset();
    mocks.resolveSshClient.mockReset();
    mocks.resolveSshClient.mockReturnValue("/usr/bin/ssh");
    mocks.spawn.mockReset();
  });

  function spawnFakeSsh({ listen = true } = {}) {
    mocks.inspectPortUsage.mockImplementation(async (port) => busyPort(port));
    mocks.spawn.mockImplementation((_cmd: string, args: string[]) => {
      const forwardSpec = args[args.indexOf("-L") + 1] ?? "";
      const localPort = Number(forwardSpec.split(":")[1]);
      if (listen) {
        const server = net.createServer();
        server.on("error", () => {});
        openServers.push(server);
        server.listen(localPort, "127.0.0.1");
      }

      return syntheticChild();
    });
  }

  async function readyTunnel(signal?: AbortSignal) {
    spawnFakeSsh();
    const tunnel = await startTunnel(await getClaimedPort(), { signal });
    return { tunnel, child: spawnedChild() };
  }

  it.each(["client", "port"] as const)("stops at a failed %s preflight", async (phase) => {
    const sentinel = new Error("stop before spawning ssh");
    if (phase === "client") {
      mocks.resolveSshClient.mockReturnValueOnce(null);
    } else {
      mocks.ensurePortAvailable.mockRejectedValueOnce(sentinel);
    }
    const starting = startTunnel(43210, { timeoutMs: 250 });
    if (phase === "client") {
      await expect(starting).rejects.toThrow("trusted SSH client not found in system directories");
      expect(mocks.ensurePortAvailable).not.toHaveBeenCalled();
    } else {
      await expect(starting).rejects.toBe(sentinel);
      expect(mocks.ensurePortAvailable).toHaveBeenCalledWith(43210, "127.0.0.1");
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["gateway-alias", undefined, "strict"],
    ["gateway-alias:22", "22", "strict"],
    ["gateway-alias", undefined, "openssh"],
  ] as const)(
    "preserves OpenSSH routing for %s (port %s, %s)",
    async (target, port, hostKeyPolicy) => {
      const stop = new Error("captured SSH process boundary");
      mocks.spawn.mockImplementationOnce(() => {
        throw stop;
      });
      await expect(startTunnel(43210, { target, hostKeyPolicy })).rejects.toBe(stop);
      const args = mocks.spawn.mock.calls[0]?.[1] as string[];
      if (port) {
        expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", port]);
      } else {
        expect(args).not.toContain("-p");
      }
      expect(args.includes("StrictHostKeyChecking=yes")).toBe(hostKeyPolicy === "strict");
      expect(args).toEqual(
        expect.arrayContaining([
          "ControlMaster=no",
          "ControlPath=none",
          "ControlPersist=no",
          "ForkAfterAuthentication=no",
        ]),
      );
    },
  );

  it.each(["PortInUseError", "EADDRINUSE", "EACCES", "EPERM"])(
    "falls back to an ephemeral port when the preferred port fails with %s",
    async (code) => {
      // Reserve the preferred port so the OS cannot reissue it during fallback.
      const preferredPort = await listenOnPort();

      mocks.ensurePortAvailable.mockRejectedValueOnce(
        code === "PortInUseError"
          ? new PortInUseError(preferredPort)
          : Object.assign(new Error(`preferred port unavailable: ${code}`), { code }),
      );
      spawnFakeSsh();

      const tunnel = await startTunnel(preferredPort);

      expect(tunnel.localPort).not.toBe(preferredPort);
      expect(tunnel.localPort).toBeGreaterThan(0);
      expect(mocks.spawn).toHaveBeenCalledWith(
        "/usr/bin/ssh",
        expect.arrayContaining(["-L", `127.0.0.1:${tunnel.localPort}:127.0.0.1:18789`]),
        expect.anything(),
      );

      await tunnel.stop();
    },
  );

  it.each([
    { ownership: "mixed", listeners: [{ pid: 4242 }, { pid: 4343 }], exits: false },
    { ownership: "unknown", listeners: [{}], exits: false },
    { ownership: "unavailable", listeners: [], exits: false },
    { ownership: "child exited during inspection", listeners: [{ pid: 4242 }], exits: true },
  ])("rejects a busy port with $ownership ownership", async ({ listeners, exits }) => {
    const localPort = await getClaimedPort();
    await listenOnPort(localPort);
    spawnFakeSsh({ listen: false });
    const inspecting = createDeferred();
    const inspection = createDeferred<PortUsage>();
    if (exits) {
      mocks.inspectPortUsage.mockImplementationOnce(() => {
        inspecting.resolve();
        return inspection.promise;
      });
    } else {
      // The competing listener wins after preflight while the child stays alive.
      mocks.inspectPortUsage.mockResolvedValueOnce(busyPort(localPort, listeners));
    }
    const forwarding = startTunnel(localPort);
    if (exits) {
      const inspected = await Promise.race([
        inspecting.promise.then(() => true),
        forwarding.then(async (tunnel) => {
          await tunnel.stop();
          return false;
        }),
      ]);
      expect(inspected).toBe(true);
    }
    const rejection = expect(forwarding).rejects.toThrow(
      exits
        ? "ssh exited before tunnel listener ownership was verified"
        : "cannot verify SSH tunnel listener ownership",
    );
    if (exits) {
      spawnedChild().emit("close", 0, null);
      inspection.resolve(busyPort(localPort, listeners));
    }
    await rejection;
    const child = spawnedChild();
    expect(child.killed).toBe(true);
    expect(mocks.inspectPortUsage).toHaveBeenCalledWith(localPort, {
      probeHosts: ["127.0.0.1"],
      signal: expect.any(AbortSignal),
    });
  });

  it.each(["term", "kill"] as const)(
    "keeps every stop caller pending until the child exits after %s",
    async (exitAfter) => {
      const { tunnel, child } = await readyTunnel();
      const signals: string[] = [];
      child.kill.mockImplementation((signal = "SIGTERM") => {
        child.killed = true;
        signals.push(signal);
        return true;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const settled: number[] = [];
      const waits = [
        tunnel.stop().then(() => settled.push(1)),
        tunnel.stop().then(() => settled.push(2)),
      ];
      cleanups.push(async () => {
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
        await Promise.all(waits);
      });
      await vi.advanceTimersByTimeAsync(exitAfter === "kill" ? 1500 : 0);
      expect(signals).toEqual(exitAfter === "kill" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
      expect(settled).toEqual([]);
      child.emit("exit", null, exitAfter === "kill" ? "SIGKILL" : "SIGTERM");
      await Promise.all(waits);
      expect(settled).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("stops an established tunnel when its owner aborts", async () => {
    const controller = new AbortController();
    const { tunnel, child } = await readyTunnel(controller.signal);

    controller.abort();

    await vi.waitFor(() => expect(child.killed).toBe(true));
    await expect(tunnel.stop()).resolves.toBeUndefined();
  });

  it("keeps startup abort pending until the SSH child exits", async () => {
    const child = syntheticChild();
    child.kill.mockImplementation(() => true);
    mocks.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const forwarding = startTunnel(await getClaimedPort(), { signal: controller.signal });
    let settled = false;
    void forwarding
      .finally(() => {
        settled = true;
      })
      .catch(() => {});

    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
    controller.abort();
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);

    child.emit("exit", null, "SIGTERM");
    await expect(forwarding).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    { terminal: "error", pending: "socket" },
    { terminal: "exit", pending: "retry" },
    { terminal: "abort", pending: "socket" },
  ])(
    "joins pending readiness $pending before startup rejects on $terminal",
    async ({ terminal, pending }) => {
      const localPort = await getClaimedPort();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const spawnError = Object.assign(
        new Error("ENOENT: no such file or directory, spawn /usr/bin/ssh"),
        { code: "ENOENT" },
      );
      const child = syntheticChild("close", -2, false);
      mocks.spawn.mockReturnValue(child);
      const controller = new AbortController();
      const abortReason = new Error("startup owner stopped");
      const socketCreated = createDeferred<net.Socket>();
      const retryScheduled = createDeferred();
      const connect = net.connect;
      const connectSpy = vi.spyOn(net, "connect").mockImplementation((...args) => {
        // Real refusal exercises the retry; an unconnected Socket holds the other
        // case at pending I/O without depending on network timing or a remote host.
        const socket = pending === "retry" ? connect(...args) : new net.Socket();
        socketCreated.resolve(socket);
        return socket;
      });
      const schedule = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
        const timer = schedule(...args);
        retryScheduled.resolve();
        return timer;
      });
      const forwarding = startTunnel(localPort, {
        timeoutMs: 500,
        signal: controller.signal,
      });
      const rejection = expect(forwarding).rejects.toMatchObject(
        terminal === "error"
          ? { message: expect.stringContaining("ENOENT"), cause: spawnError }
          : terminal === "exit"
            ? { message: "ssh exited (1)", cause: expect.any(Error) }
            : { name: "AbortError", cause: abortReason },
      );
      const socket = await socketCreated.promise;
      cleanups.push(() => {
        socket.destroy();
      });
      if (pending === "retry") {
        await retryScheduled.promise;
        expect(vi.getTimerCount()).toBe(1);
      }
      if (terminal === "abort") {
        controller.abort(abortReason);
      } else if (terminal === "error") {
        child.emit("error", spawnError);
      } else {
        child.emit("exit", 1, null);
      }
      await rejection;
      expect(socket.closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(500);
      expect(connectSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the startup budget through a forward wall-clock step", async () => {
    spawnFakeSsh({ listen: false });
    const localPort = await getClaimedPort();
    const controller = new AbortController();
    const now = Date.now;
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
    const connect = net.connect;
    vi.spyOn(net, "connect").mockImplementation((...args) => {
      // Move wall time only after the owner's initial budget timestamp is captured.
      offset = 10_000;
      return connect(...args);
    });
    const safety = setTimeout(() => controller.abort(), 1000);
    cleanups.push(() => {
      clearTimeout(safety);
      controller.abort();
    });
    const started = performance.now();
    await expect(
      startTunnel(localPort, { timeoutMs: 250, signal: controller.signal }),
    ).rejects.toThrow("ssh tunnel did not start listening");
    expect(performance.now() - started).toBeGreaterThanOrEqual(200);
  });

  it("preserves diagnostic lines split across stderr chunks at startup failure", async () => {
    const child = syntheticChild("close", 255);
    vi.spyOn(net, "connect").mockImplementation(() => new net.Socket());
    cleanups.push(() => {
      child.stderr.destroy();
    });
    mocks.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stderr.write("Warning: file /tmp/qa clé ");
        child.stderr.write("name not found.\r");
        child.stderr.write("\nFinal diagnostic without newline");
        child.stderr.end();
        child.emit("exit", 255, null);
      });
      return child;
    });
    await expect(
      startTunnel(43210, { target: "synthetic.example", timeoutMs: 250 }),
    ).rejects.toThrow(
      "ssh exited (255)\nWarning: file /tmp/qa clé name not found.\nFinal diagnostic without newline",
    );
  });

  it.each(["active", "teardown"] as const)(
    "does not crash when stderr errors while the tunnel is %s",
    async (phase) => {
      const { tunnel, child } = await readyTunnel();
      const stopping = phase === "teardown" ? tunnel.stop() : undefined;
      expect(child.killed).toBe(phase === "teardown");
      expect(() => child.stderr.emit("error", new Error("stderr EPIPE"))).not.toThrow();

      await expect(stopping ?? tunnel.stop()).resolves.toBeUndefined();
    },
  );
});
