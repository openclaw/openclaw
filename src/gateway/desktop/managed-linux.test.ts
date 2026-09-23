import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  SpawnInput,
} from "../../process/supervisor/types.js";
import { createManagedLinuxDesktop } from "./managed-linux.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const cleanups: Array<() => Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
});

function exited(stderr = ""): RunExit {
  return {
    reason: "exit",
    exitCode: 1,
    exitSignal: null,
    durationMs: 1,
    stdout: "",
    stderr,
    timedOut: false,
    noOutputTimedOut: false,
  };
}

function createFakeSupervisor() {
  const inputs: SpawnInput[] = [];
  const completedSpawns = new Map<number, ReturnType<typeof createDeferred<void>>>();
  const spawnCompletion = (count: number) => {
    let completion = completedSpawns.get(count);
    if (!completion) {
      completion = createDeferred();
      completedSpawns.set(count, completion);
    }
    return completion;
  };
  const runs: Array<{
    managed: ManagedRun;
    settle: (exit: RunExit) => void;
    settled: boolean;
    scopeKey?: string;
  }> = [];
  const supervisor: ProcessSupervisor = {
    acquireScopeCleanup(scopeKey) {
      return async () => {
        supervisor.cancelScope(scopeKey);
        await Promise.all(
          runs.filter((run) => run.scopeKey === scopeKey).map((run) => run.managed.wait()),
        );
      };
    },
    async spawn(input) {
      input.assertCurrent?.();
      inputs.push(input);
      const { promise: wait, resolve: settle } = createDeferred<RunExit>();
      const record = {
        managed: undefined as unknown as ManagedRun,
        settle,
        settled: false,
        scopeKey: input.scopeKey,
      };
      const managed: ManagedRun = {
        activity: {
          get resultSettled() {
            return record.settled;
          },
          lastOutputAtMs: 0,
        },
        runId: `run-${runs.length}`,
        startedAtMs: 0,
        wait: async () => await wait,
        cancel: () => {
          if (!record.settled) {
            record.settled = true;
            record.settle(exited());
          }
        },
      };
      record.managed = managed;
      runs.push(record);
      if (input.mode === "child" && input.argv[0] === "dbus-daemon") {
        input.onStdout?.(`${input.env?.DBUS_SESSION_BUS_ADDRESS},guid=fixture\n`);
      }
      const completion = spawnCompletion(inputs.length);
      // Notify after the spawn caller resumes; earlier native setup can await real filesystem work.
      setImmediate(() => completion.resolve());
      return managed;
    },
    cancel(runId) {
      runs.find((run) => run.managed.runId === runId)?.managed.cancel();
    },
    cancelScope(scopeKey) {
      for (const run of runs) {
        if (run.scopeKey === scopeKey) {
          run.managed.cancel();
        }
      }
    },
  };
  return {
    inputs,
    runs,
    supervisor,
    afterSpawn: (count: number) => spawnCompletion(count).promise,
    exit(index: number, stderr = "") {
      const run = runs[index];
      if (!run || run.settled) {
        throw new Error(`fake run ${index} is unavailable`);
      }
      run.settled = true;
      run.settle(exited(stderr));
    },
  };
}

async function createFixture() {
  const root = tempDirs.make("openclaw-managed-linux-test-");
  const x11SocketDir = path.join(root, "x11");
  await fs.mkdir(x11SocketDir);
  const fake = createFakeSupervisor();
  let now = 0;
  const runPasswordTool = vi.fn(async () => ({
    stdout: Buffer.from("12345678", "hex"),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
  }));
  const probeRfb = vi
    .fn()
    .mockResolvedValueOnce({ kind: "unreachable" as const })
    .mockResolvedValue({ kind: "rfb" as const, securityTypes: [2] });
  const desktop = createManagedLinuxDesktop({
    supervisor: fake.supervisor,
    runtime: {
      nowMs: () => now,
      probeRfb,
      readinessPollMs: 1,
      readinessTimeoutMs: 100,
      runPasswordTool,
      sleep: async (ms) => {
        now += ms;
      },
      tempRoot: root,
      tryListenOnPort: async () => 45_999,
      x11SocketDir,
    },
  });
  cleanups.push(() => desktop.stop());
  return { desktop, fake, probeRfb, root, runPasswordTool, x11SocketDir };
}

describe("managed Linux desktop", () => {
  it("starts lazily with the exact TigerVNC recipe and a private ephemeral password", async () => {
    vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/unrelated/bus");
    const { desktop, fake, probeRfb, root, runPasswordTool } = await createFixture();
    expect(fake.inputs).toHaveLength(0);

    const acquired = await desktop.acquire();
    expect(acquired).toMatchObject({
      attachment: { kind: "tcp", host: "127.0.0.1", port: 45_999 },
      auth: "vnc-password",
    });
    expect(acquired.vncPassword).toHaveLength(8);
    expect(isSecretValueRegisteredForRedaction(acquired.vncPassword)).toBe(true);
    expect(probeRfb).toHaveBeenCalledTimes(2);
    expect(runPasswordTool).toHaveBeenCalledWith(
      ["tigervncpasswd", "-f"],
      expect.objectContaining({ input: expect.any(Buffer) }),
    );

    const vncInput = fake.inputs[0];
    const busInput = fake.inputs[1];
    const sessionInput = fake.inputs[2];
    if (
      vncInput?.mode !== "child" ||
      busInput?.mode !== "child" ||
      sessionInput?.mode !== "child"
    ) {
      throw new Error("expected child process inputs");
    }
    const passwordFile = vncInput.argv[vncInput.argv.indexOf("-PasswordFile") + 1];
    if (!passwordFile) {
      throw new Error("expected password file argument");
    }
    expect(vncInput.argv.map((value) => (value === passwordFile ? "<password-file>" : value)))
      .toMatchInlineSnapshot(`
        [
          "Xtigervnc",
          ":99",
          "-geometry",
          "1920x1080",
          "-depth",
          "24",
          "-localhost",
          "yes",
          "-rfbport",
          "45999",
          "-SecurityTypes",
          "VncAuth",
          "-PasswordFile",
          "<password-file>",
          "-AlwaysShared",
          "-AcceptSetDesktopSize",
          "-nolisten",
          "tcp",
          "-ac",
        ]
      `);
    expect(sessionInput.argv).toMatchInlineSnapshot(`
      [
        "startxfce4",
      ]
    `);
    expect(sessionInput.env?.DISPLAY).toBe(":99");
    expect(busInput.argv).toEqual([
      "dbus-daemon",
      "--session",
      "--nofork",
      "--nopidfile",
      "--print-address=1",
      `--address=unix:path=${path.join(path.dirname(passwordFile), "bus")}`,
    ]);
    const computer = await desktop.acquireComputer({ onStop: async () => undefined });
    expect(computer.env).toEqual(sessionInput.env);
    expect(computer.env.DBUS_SESSION_BUS_ADDRESS).toBe(
      `unix:path=${path.join(path.dirname(passwordFile), "bus")}`,
    );
    expect(computer.env.WAYLAND_DISPLAY).toBeUndefined();
    expect(computer.env.XDG_SESSION_TYPE).toBe("x11");
    expect(Object.isFrozen(computer.env)).toBe(true);
    expect(process.env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/unrelated/bus");
    expect((await fs.stat(passwordFile)).mode & 0o777).toBe(0o600);
    await expect(fs.stat(path.join(path.dirname(passwordFile), "password.txt"))).rejects.toThrow();

    await desktop.stop();
    await expect(fs.stat(path.dirname(passwordFile))).rejects.toThrow();
    expect(desktop.status()).toEqual({ state: "not-started" });
    expect(passwordFile.startsWith(root)).toBe(true);
  });

  it("chooses the first free display from :99 and a fresh password for each session", async () => {
    const { desktop, fake, x11SocketDir } = await createFixture();
    await fs.writeFile(path.join(x11SocketDir, "X99"), "");
    await fs.writeFile(path.join(x11SocketDir, "X100"), "");
    const first = await desktop.acquire();
    expect((fake.inputs[0] as Extract<SpawnInput, { mode: "child" }>).argv[1]).toBe(":101");
    await desktop.stop();
    const second = await desktop.acquire();
    expect(second.vncPassword).not.toBe(first.vncPassword);
    await desktop.stop();
  });

  it.each(["Xtigervnc", "startxfce4", "tigervncpasswd", "dbus-daemon"] as const)(
    "names a missing %s binary and the install command",
    async (missingBinary) => {
      const fixture = await createFixture();
      const supervisor: ProcessSupervisor = {
        ...fixture.fake.supervisor,
        async spawn(input) {
          const binary = input.mode === "child" ? input.argv[0] : undefined;
          if (binary === missingBinary) {
            throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
          }
          return await fixture.fake.supervisor.spawn(input);
        },
      };
      const runPasswordTool =
        missingBinary === "tigervncpasswd"
          ? vi.fn(async () => ({
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("spawn ENOENT"),
              code: null,
              signal: null,
              killed: false,
              termination: "error" as const,
            }))
          : fixture.runPasswordTool;
      const desktop = createManagedLinuxDesktop({
        supervisor,
        runtime: {
          probeRfb: async () => ({ kind: "rfb", securityTypes: [2] }),
          runPasswordTool,
          tempRoot: fixture.root,
          tryListenOnPort: async () => 45_999,
          x11SocketDir: fixture.x11SocketDir,
        },
      });

      await expect(desktop.acquire()).rejects.toThrow(missingBinary);
      await expect(desktop.acquire()).rejects.toThrow(
        "apt install tigervnc-standalone-server tigervnc-tools xfce4-session",
      );
      await desktop.stop();
    },
  );

  it("restarts the pair three times, then reports the last stderr line as failed", async () => {
    const failed = createDeferred();
    const onFailed = vi.fn(() => failed.resolve());
    const fixture = await createFixture();
    const desktop = createManagedLinuxDesktop({
      supervisor: fixture.fake.supervisor,
      onFailed,
      runtime: {
        probeRfb: async () => ({ kind: "rfb", securityTypes: [2] }),
        runPasswordTool: fixture.runPasswordTool,
        tempRoot: fixture.root,
        tryListenOnPort: async () => 45_999,
        x11SocketDir: fixture.x11SocketDir,
      },
    });
    await desktop.acquire();
    for (const [crash, inputIndex] of [
      [0, 0],
      [1, 3],
      [2, 6],
    ] as const) {
      fixture.fake.exit(inputIndex, `restart ${crash}\n`);
      await fixture.fake.afterSpawn(inputIndex + 6);
      expect(fixture.fake.inputs).toHaveLength(inputIndex + 6);
    }
    fixture.fake.exit(9, "detail line\nlast stderr line\n");
    await failed.promise;
    expect(desktop.status()).toMatchObject({
      state: "failed",
      error: expect.stringContaining("last stderr line"),
      display: 99,
      port: 45_999,
    });
    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining("3 restarts within 5 minutes"));
    await desktop.stop();
  });

  it("joins computer cleanup before stopping its display and bus", async () => {
    const { desktop, fake } = await createFixture();
    await desktop.acquire();
    const cleanup = createDeferred();
    cleanups.push(async () => cleanup.resolve());
    const stopStarted = createDeferred();
    const onStop = vi.fn(async () => {
      stopStarted.resolve();
      await cleanup.promise;
    });
    const computer = await desktop.acquireComputer({ onStop });
    const stopped = desktop.stop();
    expect(desktop.stop()).toBe(stopped);
    expect(computer.isCurrent()).toBe(false);
    await stopStarted.promise;
    expect(fake.runs.every((run) => !run.settled)).toBe(true);
    await expect(desktop.acquireComputer({ onStop })).rejects.toThrow("unavailable");
    cleanup.resolve();
    await stopped;
    expect(fake.runs.every((run) => run.settled)).toBe(true);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2])(
    "retires computer references before replacing a crashed desktop process %s",
    async (crashedProcess) => {
      const { desktop, fake } = await createFixture();
      await desktop.acquire();
      const cleanup = createDeferred();
      cleanups.push(async () => cleanup.resolve());
      const stopStarted = createDeferred();
      const onStop = vi.fn(async () => {
        stopStarted.resolve();
        await cleanup.promise;
      });
      const previous = await desktop.acquireComputer({ onStop });
      fake.exit(crashedProcess);
      await stopStarted.promise;
      expect(onStop).toHaveBeenCalledOnce();
      expect(previous.isCurrent()).toBe(false);
      expect(fake.runs.filter((run) => !run.settled)).toHaveLength(2);
      expect(fake.inputs).toHaveLength(3);
      await expect(desktop.acquireComputer({ onStop })).rejects.toThrow("unavailable");
      cleanup.resolve();
      await fake.afterSpawn(6);
      expect(fake.inputs).toHaveLength(6);
      expect(desktop.status().state).toBe("running");
      const next = await desktop.acquireComputer({ onStop: async () => undefined });
      expect(next.isCurrent()).toBe(true);
      expect(previous.isCurrent()).toBe(false);
      previous.release();
      expect(next.isCurrent()).toBe(true);
    },
  );

  it("stops and removes its session when the registry linger expires", async () => {
    const { desktop } = await createFixture();
    const registry = createDesktopSessionRegistry({ lingerMs: 1 });
    cleanups.push(async () => registry.stopAll());
    await registry.acquire({
      sourceKey: "host",
      ownerEpoch: 0,
      start: () => desktop.acquire(),
      teardown: () => desktop.stop(),
    });
    const observer = registry.attachObserver("host", {
      control: false,
      ownerEpoch: 0,
      close: vi.fn(),
    });
    expect(observer).toBeDefined();
    observer?.release();
    await vi.waitFor(() => expect(desktop.status()).toEqual({ state: "not-started" }));
  });
});
