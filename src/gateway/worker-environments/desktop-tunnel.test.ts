import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { withinTest } from "../../../test/helpers/promise.js";
import type { WorkerDesktopEndpoint } from "../../plugins/types.js";
import type { SpawnResult } from "../../process/exec.js";
import { withMockedWindowsPlatform } from "../../test-utils/vitest-spies.js";
import { createDesktopSessionRegistry } from "../desktop/session-registry.js";
import { createWorkerDesktopTunnels } from "./desktop-tunnel.js";
import {
  deferred,
  fakeRunner as createFakeRunner,
  resolveIdentity,
  SSH,
  success,
  waitForStarts,
} from "./tunnel.test-support.js";

const desktopInfo = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/desktop" ? { ...logger, info: desktopInfo } : logger;
    },
  };
});

const DESKTOP: WorkerDesktopEndpoint = {
  protocol: "rfb",
  port: 5900,
  passwordFilePath: "/var/lib/crabbox/vnc.password",
};
const PLAIN_DESKTOP: WorkerDesktopEndpoint = { protocol: "rfb", port: 5900 };
function fakeRunner(onRun?: Parameters<typeof createFakeRunner>[0]) {
  return createFakeRunner(onRun, { defaultStdout: "vnc-secret\n", deferStop: true });
}

function readyRunner() {
  const fake = fakeRunner();
  const start = fake.runner.start.bind(fake.runner);
  fake.runner.start = (argv, options) => {
    const child = start(argv, options);
    fake.starts.at(-1)!.process.becomeReady();
    return child;
  };
  return fake;
}

const managers = new Set<ReturnType<typeof createWorkerDesktopTunnels>>();
function setup(
  fake = fakeRunner(),
  options: Omit<Parameters<typeof createWorkerDesktopTunnels>[0], "runner"> = {},
) {
  const manager = createWorkerDesktopTunnels({ runner: fake.runner, ...options });
  managers.add(manager);
  return { fake, manager };
}

async function ready(fake: ReturnType<typeof fakeRunner>, count = 1) {
  await waitForStarts(fake.starts, count);
  fake.starts[count - 1]!.process.becomeReady();
}

async function connected(ownerEpoch = 1, options: Parameters<typeof setup>[1] = {}) {
  const context = setup(readyRunner(), options);
  const result = await acquire(context.manager, ownerEpoch, PLAIN_DESKTOP);
  return { ...context, ...result };
}

function socketPath(attachment: Awaited<ReturnType<typeof acquire>>["attachment"]) {
  if (attachment.kind !== "unix-socket") {
    throw new Error("expected an SSH desktop socket");
  }
  return attachment.socketPath;
}

function socketDirectory(attachment: Awaited<ReturnType<typeof acquire>>["attachment"]) {
  return path.dirname(socketPath(attachment));
}

async function expectRemoved(directory: string) {
  await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
}

function observer(
  manager: ReturnType<typeof createWorkerDesktopTunnels>,
  control = false,
  ownerEpoch = 1,
  close = vi.fn(),
) {
  return manager.attachObserver("worker:one", { control, ownerEpoch, close });
}

function launchApp(
  manager: ReturnType<typeof createWorkerDesktopTunnels>,
  ownerEpoch = 1,
  ssh = SSH,
  args?: string[],
) {
  return manager.launchApp({
    environmentId: "worker:one",
    ownerEpoch,
    ssh,
    app: {
      id: "browser",
      executablePath: "/usr/local/bin/openclaw-worker-browser",
      ...(args ? { args } : {}),
      cdpPort: 9222,
    },
    resolveIdentity,
  });
}

function acquire(
  manager: ReturnType<typeof createWorkerDesktopTunnels>,
  ownerEpoch = 1,
  desktop = DESKTOP,
  overrides: Partial<Parameters<typeof manager.acquire>[0]> = {},
) {
  return manager.acquire({
    environmentId: "worker:one",
    ownerEpoch,
    ssh: SSH,
    desktop,
    resolveIdentity,
    ...overrides,
  });
}

const fixture = createFixtureLifetime();
afterEach(async () => {
  // Timeout teardown must join the original body before restoring its shared mocks.
  await fixture.cleanup();
  for (const manager of managers) {
    await manager.stopAll();
  }
  managers.clear();
  vi.useRealTimers();
  desktopInfo.mockReset();
});

describe("worker desktop tunnels", () => {
  it("records SSH exit before owner cleanup even if the logger throws", async () => {
    const { fake, manager, attachment } = await connected();
    const order: string[] = [];
    const close = vi.fn(() => order.push("observer-close"));
    observer(manager, false, 1, close);
    desktopInfo.mockImplementation((message) => {
      if (message === "desktop SSH tunnel exited") {
        order.push("SSH-exit");
        throw new Error("fixture logger unavailable");
      }
    });
    fake.starts[0]!.process.exit();
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(1012, "desktop tunnel closed"));
    expect(desktopInfo).toHaveBeenCalledWith("desktop SSH tunnel exited", {
      code: 1,
      signal: null,
      stopRequested: false,
    });
    expect(fake.starts[0]!.process.stopCount).toBe(1);
    expect(order).toEqual(["SSH-exit", "observer-close"]);
    await manager.stopAll();
    await expectRemoved(socketDirectory(attachment));
  });

  it.skipIf(process.platform === "win32")(
    "keeps the socket and credentials in one short private directory despite a long temp root",
    async ({ onTestFinished }) => {
      const root = await mkdtemp("/tmp/oc-desktop-test-");
      const ambient = path.join(root, "long-temporary-root-" + "x".repeat(120));
      const { fake, manager } = setup();
      onTestFinished(async () => {
        await manager.stopAll();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      });
      await mkdir(ambient);
      vi.stubEnv("TMPDIR", ambient);
      const starting = acquire(manager, 1, PLAIN_DESKTOP, {
        environmentId: "worker:long-path",
        resolveIdentity: async () => ({ kind: "material", contents: "synthetic-identity" }),
      });
      await ready(fake);
      const { attachment } = await starting;
      const directory = socketDirectory(attachment);
      expect(Buffer.byteLength(socketPath(attachment))).toBeLessThanOrEqual(103);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const name of ["identity", "known_hosts"]) {
        expect((await stat(path.join(directory, name))).mode & 0o777).toBe(0o600);
      }
      await manager.stopAll();
      await expectRemoved(directory);
    },
  );

  it("creates one pinned local forward per epoch and caches the password", async () => {
    const { fake, manager } = setup();
    const starting = acquire(manager);
    await waitForStarts(fake.starts, 1);
    const start = fake.starts[0]!;
    expect(start.argv).toEqual(
      expect.arrayContaining([
        "ClearAllForwardings=no",
        "StreamLocalBindMask=0177",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
        "-N",
        "-n",
        "PermitLocalCommand=yes",
        "LocalCommand=printf 'OPENCLAW_WORKER_TUNNEL_READY\\n'",
      ]),
    );
    expect(start.argv[start.argv.indexOf("-L") + 1]).toMatch(
      /openclaw-worker-desktop-.+\/desktop\.sock:127\.0\.0\.1:5900$/u,
    );
    expect(start.argv.at(-1)).toBe("worker@worker.example.test");
    expect(start.options.input).toBeUndefined();
    start.process.becomeReady();
    const result = await starting;
    expect(result).toMatchObject({ vncPassword: "vnc-secret" });
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]?.argv.at(-1)).toContain("/var/lib/crabbox/vnc.password");

    await expect(acquire(manager)).resolves.toEqual(result);
    expect(fake.starts).toHaveLength(1);
    expect(fake.runs).toHaveLength(1);
  });

  it("expires an unattached acquisition and disposes its SSH identity directory", async () => {
    vi.useFakeTimers();
    const { fake, manager } = setup();
    const starting = acquire(manager);
    await ready(fake);
    const result = await starting;
    const identityDirectory = socketDirectory(result.attachment);
    await access(identityDirectory);
    await vi.advanceTimersByTimeAsync(59_999);
    await expect(acquire(manager)).resolves.toEqual(result);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.starts[0]!.process.stopCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.starts[0]!.process.stopCount).toBe(1);
    await manager.stopAll();
    await expectRemoved(identityDirectory);
  });

  it("fences an older epoch before starting its replacement", async () => {
    const { fake, manager } = await connected();

    const second = acquire(manager, 2, { protocol: "rfb", port: 5901 });
    await waitForStarts(fake.starts, 2);
    expect(fake.starts[0]?.process.stopCount).toBe(1);
    expect(fake.starts[1]?.argv[fake.starts[1]!.argv.indexOf("-L") + 1]).toContain(
      ":127.0.0.1:5901",
    );
    fake.starts[1]?.process.becomeReady();
    await second;
    await expect(acquire(manager, 1)).rejects.toThrow("owner epoch is stale");
  });

  it("fences stop by owner epoch while allowing matching and unconditional teardown", async () => {
    const { fake, manager } = await connected(2);

    await manager.stop("worker:one", 1);
    expect(fake.starts[0]?.process.stopCount).toBe(0);
    await manager.stop("worker:one", 2);
    expect(fake.starts[0]?.process.stopCount).toBe(1);

    await acquire(manager, 3, PLAIN_DESKTOP);
    await manager.stop("worker:one");
    expect(fake.starts[1]?.process.stopCount).toBe(1);
  });

  it("enforces controller takeover and the observer cap", async () => {
    const { manager } = await connected();

    const firstClose = vi.fn();
    const first = observer(manager, true, 1, firstClose);
    const second = observer(manager, true);
    expect(firstClose).toHaveBeenCalledWith(4000, "control-taken");
    first?.release();
    const observers = Array.from({ length: 7 }, () => observer(manager));
    expect(observers.every(Boolean)).toBe(true);
    expect(observer(manager)).toBeUndefined();
    second?.release();
    observers.forEach((attachedObserver) => attachedObserver?.release());
  });

  it("retains SSH resources after failed stop and releases them on late exit", ({ signal }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      const fake = fakeRunner();
      const disposed = deferred<void>();
      const registry = createDesktopSessionRegistry();
      const acquireSession = registry.acquire;
      registry.acquire = (request) =>
        acquireSession({
          ...request,
          dispose: () => {
            const disposal = request.dispose?.() ?? Promise.resolve();
            void disposal.then(disposed.resolve, disposed.reject);
            return disposal;
          },
        });
      const manager = setup(fake, { registry }).manager;
      let directory: string | undefined;
      let restoreStop = () => {};
      try {
        const starting = fixture.track(acquire(manager, 1, { protocol: "rfb", port: 5900 }));
        await waitForStarts(fake.starts, 1);
        signal.throwIfAborted();
        const child = fake.starts[0]!.process;
        child.becomeReady();
        const { attachment } = await withinTest(starting, signal);
        directory = socketDirectory(attachment);
        const failure = new Error("SSH child may still be running");
        const stop = vi.spyOn(child, "stop").mockRejectedValue(failure);
        restoreStop = () => stop.mockRestore();
        await expect(manager.stop("worker:one", 1)).rejects.toBe(failure);
        await access(directory);
        await expect(acquire(manager, 2)).rejects.toBe(failure);
        expect(fake.starts).toHaveLength(1);
        expect(desktopInfo).not.toHaveBeenCalled();
        stop.mockRestore();
        child.exit();
        await withinTest(disposed.promise, signal);
        await expectRemoved(directory);
        expect(desktopInfo).toHaveBeenCalledExactlyOnceWith("desktop SSH tunnel exited", {
          code: 1,
          signal: null,
          stopRequested: true,
        });
      } finally {
        await fixture.verifyCleanup(async () => {
          restoreStop();
          await manager.stopAll();
          if (directory) {
            await rm(directory, { recursive: true, force: true });
          }
        });
      }
    }));

  it("joins identity preparation when stopped before spawning", async () => {
    const identity = deferred<Awaited<ReturnType<typeof resolveIdentity>>>();
    const resolving = deferred<void>();
    const { fake, manager } = setup();
    const starting = acquire(manager, 1, DESKTOP, {
      resolveIdentity: () => {
        resolving.resolve();
        return identity.promise;
      },
    });
    const rejected = expect(starting).rejects.toThrow("stopped before connecting");
    await resolving.promise;
    let stopped = false;
    const stopping = manager.stop("worker:one", 1).then(() => {
      stopped = true;
    });
    try {
      await rejected;
      await setImmediate();
      expect(stopped).toBe(false);
      expect(fake.starts).toHaveLength(0);
    } finally {
      identity.resolve(await resolveIdentity());
      await stopping;
    }
    expect(fake.starts).toHaveLength(0);
  });

  it("retries the same epoch after explicit recovery of a failed stop", async () => {
    const { fake, manager } = await connected();
    const failure = new Error("transport still running");
    const stop = vi.spyOn(fake.starts[0]!.process, "stop").mockRejectedValueOnce(failure);
    try {
      await expect(manager.stop("worker:one", 1)).rejects.toBe(failure);
      stop.mockRestore();
      await expect(acquire(manager, 1, PLAIN_DESKTOP)).rejects.toBe(failure);
      await manager.stop("worker:one", 1);
      await expect(acquire(manager, 1, PLAIN_DESKTOP)).resolves.toMatchObject({
        attachment: { kind: "unix-socket" },
      });
      expect(fake.starts).toHaveLength(2);
    } finally {
      stop.mockRestore();
    }
  });

  it("aborts and joins stale app launches even when predecessor teardown fails", async () => {
    const launchResult = deferred<SpawnResult>();
    const fake = fakeRunner(() => launchResult.promise);
    const manager = setup(fake).manager;
    const starting = acquire(manager, 1, { protocol: "rfb", port: 5900 });
    await ready(fake);
    await starting;
    const launching = launchApp(manager);
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    const failure = new Error("predecessor still running");
    const stop = vi.spyOn(fake.starts[0]!.process, "stop").mockRejectedValue(failure);
    let settled = false;
    const replacing = acquire(manager, 2, { protocol: "rfb", port: 5900 }).finally(() => {
      settled = true;
    });
    const rejected = expect(replacing).rejects.toBe(failure);
    try {
      await setImmediate();
      expect(fake.runs[0]!.options.signal?.aborted).toBe(true);
      expect(settled).toBe(false);
    } finally {
      launchResult.resolve(success());
      await Promise.all([launching, rejected]);
      stop.mockRestore();
    }
    expect(fake.starts).toHaveLength(1);
  });

  it("publishes a replacement before a stale launch abort can reenter Stop", async () => {
    let reentrantStop: Promise<void> | undefined;
    const fake = fakeRunner(
      (_argv, options) =>
        new Promise<SpawnResult>((resolve) => {
          options.signal!.addEventListener(
            "abort",
            () => {
              reentrantStop = manager.stop("worker:one", 2);
              resolve(success());
            },
            { once: true },
          );
        }),
    );
    const manager = setup(fake).manager;
    const launching = launchApp(manager);
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    try {
      await expect(acquire(manager, 2, { protocol: "rfb", port: 5900 })).rejects.toThrow(
        "stopped before connecting",
      );
      await Promise.all([launching, reentrantStop]);
      expect(reentrantStop).toBeDefined();
      expect(fake.starts).toHaveLength(0);
    } finally {
      await manager.stopAll();
    }
  });

  it("cancels a replacement while the previous desktop is stopping", async () => {
    const { fake, manager } = await connected();
    const child = fake.starts[0]!.process;
    const stop = child.stop.bind(child);
    const entered = deferred<void>();
    const release = deferred<void>();
    const stoppingChild = vi.spyOn(child, "stop").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      await stop();
    });
    const replacement = acquire(manager, 2, PLAIN_DESKTOP);
    const outcome = replacement.then(
      () => "ready",
      () => "stopped",
    );
    await entered.promise;
    const stopping = manager.stop("worker:one", 2);
    release.resolve();
    try {
      await stopping;
      expect(await outcome).toBe("stopped");
      expect(fake.starts).toHaveLength(1);
    } finally {
      stoppingChild.mockRestore();
    }
  });

  it.each(["readiness", "password"] as const)(
    "joins %s before disposing a cancelled desktop",
    async (phase) => {
      const password = deferred<SpawnResult>();
      const fake = fakeRunner(() => password.promise);
      const manager = setup(fake).manager;
      const starting = acquire(manager);
      const rejected = expect(starting).rejects.toThrow("stopped before connecting");
      await waitForStarts(fake.starts, 1);
      const started = fake.starts[0]!;
      const socket = started.argv[started.argv.indexOf("-L") + 1]!.split(":127.0.0.1:")[0]!;
      const directory = path.dirname(socket);
      if (phase === "password") {
        started.process.becomeReady();
        await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
      }
      const stopping = manager.stop("worker:one", 1);
      try {
        await rejected;
        if (phase === "password") {
          await setImmediate();
          await access(directory);
        }
      } finally {
        password.resolve(success("synthetic-password"));
        await stopping;
        await manager.stopAll();
      }
      await expectRemoved(directory);
    },
  );

  it("lingers after the last observer and closes observers on child exit", async () => {
    vi.useFakeTimers();
    const { fake, manager } = await connected();
    const close = vi.fn();
    const attached = observer(manager, false, 1, close);
    attached?.release();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.starts[0]?.process.stopCount).toBe(0);
    const replacement = observer(manager, false, 1, close);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.starts[0]?.process.stopCount).toBe(0);
    fake.starts[0]?.process.exit();
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(1012, "desktop tunnel closed"));
    replacement?.release();
  });

  it("refuses observer tokens minted against a replaced owner epoch", async () => {
    const { manager } = await connected();
    await acquire(manager, 2);

    const controllerClose = vi.fn();
    const controller = observer(manager, true, 2, controllerClose);
    expect(controller).toBeDefined();

    // A stale control token must not reach the replacement entry or evict its controller.
    expect(observer(manager, true)).toBeUndefined();
    expect(controllerClose).not.toHaveBeenCalled();

    controller?.release();
  });

  it("requires node transport for managed desktop accounts before spawning SSH", async () => {
    const { fake, manager } = setup();
    await expect(acquire(manager, 1, { ...DESKTOP, username: "desktop-user" })).rejects.toThrow(
      "requires the worker node transport",
    );
    expect(fake).toMatchObject({ starts: [], runs: [] });
  });

  it("rejects Windows gateway hosts before spawning SSH", async () => {
    const fake = fakeRunner();
    const manager = withMockedWindowsPlatform(() => setup(fake).manager);
    const acquiring = acquire(manager);
    await expect(acquiring).rejects.toMatchObject({ code: "unsupported_platform" });
    await expect(acquiring).rejects.toThrow(
      "desktop observe is not supported on Windows gateway hosts",
    );
    expect(fake.starts).toEqual([]);
  });

  it.each([{ args: undefined }, { args: ["arg with spaces", "literal;$(text)"] }])(
    "deduplicates one exact launcher with args $args per app and epoch",
    async ({ args }) => {
      const result = deferred<SpawnResult>();
      const fake = fakeRunner(async () => await result.promise);
      const manager = setup(fake).manager;

      const first = launchApp(manager, 1, SSH, args);
      const second = launchApp(manager, 1, SSH, args);
      await vi.waitFor(() => expect(fake.runs).toHaveLength(1), { interval: 1 });
      const run = fake.runs[0]!;
      expect(run.argv.at(-1)).toBe(
        "'/usr/local/bin/openclaw-worker-browser'" +
          (args ? " 'arg with spaces' 'literal;$(text)'" : ""),
      );
      expect(run.argv.at(-1)).not.toContain("9222");
      expect(run.argv.at(-1)).not.toContain(".cache/openclaw");
      expect(run.options.timeoutMs).toBeGreaterThan(0);
      expect(run.options.timeoutMs).toBeLessThanOrEqual(30_000);
      expect(run.options.signal).toBeInstanceOf(AbortSignal);
      result.resolve(success());

      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    },
  );

  it("does not replay an app launch after ambiguous SSH exit 255", async () => {
    const fake = fakeRunner(() => ({
      ...success(),
      code: 255,
      stderr: "connection lost after remote acceptance",
    }));
    const manager = setup(fake).manager;

    await expect(launchApp(manager, 1, { ...SSH, fallbackPorts: [2203] })).rejects.toThrow(
      "connection lost after remote acceptance",
    );
    expect(fake.runs.map(({ argv }) => argv[argv.indexOf("-p") + 1])).toEqual(["2202"]);
  });

  it("aborts pending launchers on matching teardown and fences stale epochs", async () => {
    const signals: AbortSignal[] = [];
    const fake = fakeRunner(
      async (_argv, options) =>
        await new Promise<SpawnResult>((_resolve, reject) => {
          const signal = options.signal!;
          signals.push(signal);
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("launcher aborted", { cause: signal.reason }),
              ),
            { once: true },
          );
        }),
    );
    const manager = setup(fake).manager;
    const launching = launchApp(manager);
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1), { interval: 1 });

    await manager.stop("worker:one", 1);
    await expect(launching).rejects.toThrow("owner stopped");
    expect(signals[0]?.aborted).toBe(true);
    await expect(launchApp(manager, 0)).rejects.toThrow("owner epoch is stale");
  });

  it("publishes launcher ownership before immediate teardown can observe it", async () => {
    const { fake, manager } = setup();

    const launching = launchApp(manager);
    const stopping = manager.stop("worker:one", 1);

    await expect(launching).rejects.toThrow("owner stopped");
    await stopping;
    expect(fake.runs).toEqual([]);
  });

  it("reports unsupported launcher platforms and nonzero launcher exits", async () => {
    const unsupported = withMockedWindowsPlatform(() =>
      createWorkerDesktopTunnels({ runner: fakeRunner().runner }),
    );
    const launching = launchApp(unsupported);
    await expect(launching).rejects.toMatchObject({ code: "unsupported_platform" });
    await expect(launching).rejects.toThrow(
      "desktop app launch is not supported on Windows gateway hosts",
    );

    const failed = createWorkerDesktopTunnels({
      runner: fakeRunner(() => ({ ...success(), code: 7, stderr: "launcher failed" })).runner,
    });
    await expect(launchApp(failed)).rejects.toThrow("launcher failed");
    await failed.stopAll();
  });

  it("keeps a same-epoch desktop session alive when an app launch fences replaced owners", async () => {
    const { fake, manager } = setup();
    // Fencing runs after the same-epoch observer exists; it must not retire it.
    const launching = launchApp(manager, 1);
    const starting = acquire(manager, 1);
    await ready(fake);
    await starting;
    await launching;

    const attached = observer(manager);
    expect(attached).toBeDefined();
    attached?.release();
  });
});
