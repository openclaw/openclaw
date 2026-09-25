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
import { createManagedLinuxAudio } from "./managed-linux-audio.js";
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
      if (input.mode === "child" && input.argv[0] === "pulseaudio") {
        input.onStderr?.("Daemon startup complete.\n");
      }
      if (input.mode === "child" && input.argv[0] === "parec") {
        input.onStdoutRaw?.(Buffer.alloc(4));
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

const noAudio: typeof createManagedLinuxAudio = (params) => {
  // Factories may consult admission before the asynchronous desktop pair exists.
  params.assertCurrent();
  const stop = vi.fn(async () => undefined);
  return { ready: Promise.resolve({ unavailableReason: "parec is not installed", stop }), stop };
};

async function createFixture(createAudio = noAudio, onFailed?: (error: string) => void) {
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
    onFailed,
    runtime: {
      createAudio,
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
  return {
    desktop,
    fake,
    probeRfb,
    root,
    runPasswordTool,
    x11SocketDir,
    advanceTime: (ms: number) => {
      now += ms;
    },
  };
}

describe("managed Linux desktop", () => {
  it("recovers the private route without replacing healthy applications or computer leases", async () => {
    const createAudio: typeof createManagedLinuxAudio = (params) =>
      createManagedLinuxAudio({ ...params, runtime: { detectBinary: async () => true } });
    const { desktop, fake } = await createFixture(createAudio);
    const acquired = await desktop.acquire();
    const onStop = vi.fn(async () => undefined);
    const lease = await desktop.acquireComputer({ onStop });
    const source = acquired.resolveAudio!()!;
    const capture = await source.start(new AbortController().signal);
    fake.exit(1);
    await fake.afterSpawn(6);
    expect(capture.stream.destroyed).toBe(true);
    await expect(source.start(new AbortController().signal)).rejects.toThrow();
    expect(lease.isCurrent()).toBe(true);
    expect(onStop).not.toHaveBeenCalled();
    expect([0, 2, 3].every((index) => !fake.runs[index]!.settled)).toBe(true);
    expect(fake.inputs[5]!.env?.PULSE_SERVER).toBe(lease.env.PULSE_SERVER);
    expect(acquired.resolveAudio!()).not.toBe(source);
    const next = await acquired.resolveAudio!()!.start(new AbortController().signal);
    await desktop.stop();
    expect(next.stream.destroyed).toBe(true);
    expect(onStop).toHaveBeenCalledOnce();
    expect(fake.runs.every((run) => run.settled)).toBe(true);
  });

  it("leaves audio unavailable without replacing healthy apps when recovery cannot start", async () => {
    vi.stubEnv("PULSE_SERVER", "unix:/operator/pulse/native");
    const recoveryFinished = createDeferred();
    let available = true;
    const createAudio: typeof createManagedLinuxAudio = (params) => {
      const owner = createManagedLinuxAudio({
        ...params,
        runtime: { detectBinary: async () => available },
      });
      if (!available) {
        void owner.ready.then(() => setImmediate(() => recoveryFinished.resolve()));
      }
      return owner;
    };
    const onFailed = vi.fn();
    const { desktop, fake } = await createFixture(createAudio, onFailed);
    const acquired = await desktop.acquire();
    const source = acquired.resolveAudio!()!;
    const capture = await source.start(new AbortController().signal);
    const onStop = vi.fn(async () => undefined);
    const lease = await desktop.acquireComputer({ onStop });
    available = false;
    fake.exit(1);
    await recoveryFinished.promise;
    expect(lease.isCurrent()).toBe(true);
    expect(onStop).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(desktop.status().state).toBe("running");
    expect([0, 2, 3].every((index) => !fake.runs[index]!.settled)).toBe(true);
    expect(fake.inputs).toHaveLength(5);
    expect(capture.stream.destroyed).toBe(true);
    expect(acquired.resolveAudio!()).toBeUndefined();
    expect(acquired.audioUnavailableReason).toContain("not installed");
    expect(acquired.audioUnavailableReason).toContain(
      "restart the managed desktop if audio is needed",
    );
    await expect(source.start(new AbortController().signal)).rejects.toThrow();
    const next = await desktop.acquireComputer({ onStop: async () => undefined });
    expect(next.env).toBe(lease.env);
    expect(next.env.PULSE_SERVER).not.toBe(process.env.PULSE_SERVER);
    await desktop.stop();
    expect(onStop).toHaveBeenCalledOnce();
    expect(fake.runs.every((run) => run.settled)).toBe(true);
  });

  it.each(["stop", "desktop exit"])("joins pending audio recovery on %s", async (event) => {
    const entered = createDeferred();
    const admission = createDeferred();
    cleanups.push(async () => admission.resolve());
    let generation = 0;
    const createAudio: typeof createManagedLinuxAudio = (params) => {
      const recovering = generation++ === 1;
      return createManagedLinuxAudio({
        ...params,
        runtime: {
          detectBinary: async () => {
            if (recovering) {
              entered.resolve();
              await admission.promise;
            }
            return true;
          },
        },
      });
    };
    const { desktop, fake } = await createFixture(createAudio);
    const acquired = await desktop.acquire();
    const source = acquired.resolveAudio!()!;
    fake.exit(1);
    await entered.promise;
    expect(acquired.resolveAudio!()).toBeUndefined();
    if (event === "stop") {
      let settled = false;
      const stopped = desktop.stop().then(() => {
        settled = true;
      });
      expect(settled).toBe(false);
      admission.resolve();
      await stopped;
      expect(fake.inputs).toHaveLength(4);
      expect(fake.runs.every((run) => run.settled)).toBe(true);
    } else {
      fake.exit(0);
      admission.resolve();
      await fake.afterSpawn(8);
      expect(desktop.status().state).toBe("running");
      expect(acquired.resolveAudio!()).toBeDefined();
    }
    await expect(source.start(new AbortController().signal)).rejects.toThrow();
  });

  it("exhausts only the audio budget and preserves the independent desktop budget", async () => {
    const audioStopped = createDeferred();
    const failed = createDeferred();
    const onFailed = vi.fn(() => failed.resolve());
    let generation = 0;
    const createAudio: typeof createManagedLinuxAudio = (params) => {
      const owner = createManagedLinuxAudio({
        ...params,
        runtime: { detectBinary: async () => true },
      });
      if (++generation === 4) {
        void owner.ready.then((audio) => {
          const stop = audio.stop.bind(audio);
          audio.stop = async () => {
            await stop();
            setImmediate(() => audioStopped.resolve());
          };
          owner.stop = () => audio.stop();
        });
      }
      return owner;
    };
    const { desktop, fake } = await createFixture(createAudio, onFailed);
    const acquired = await desktop.acquire();
    const onStop = vi.fn(async () => undefined);
    const lease = await desktop.acquireComputer({ onStop });
    const original = acquired.resolveAudio!()!;
    for (const index of [1, 4, 5]) {
      fake.exit(index);
      await fake.afterSpawn(Math.max(5, index + 2));
    }
    const lastSource = acquired.resolveAudio!()!;
    const capture = await lastSource.start(new AbortController().signal);
    fake.exit(6);
    await audioStopped.promise;
    expect(desktop.status().state).toBe("running");
    expect(lease.isCurrent()).toBe(true);
    expect(onStop).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect([0, 2, 3].every((index) => !fake.runs[index]!.settled)).toBe(true);
    expect(fake.inputs).toHaveLength(8);
    expect(capture.stream.destroyed).toBe(true);
    expect(acquired.resolveAudio!()).toBeUndefined();
    expect(acquired.audioUnavailableReason).toContain("3 restarts within 5 minutes");
    expect(acquired.audioUnavailableReason).toContain(
      "restart the managed desktop if audio is needed",
    );
    await expect(original.start(new AbortController().signal)).rejects.toThrow();
    await expect(lastSource.start(new AbortController().signal)).rejects.toThrow();
    expect((await desktop.acquire()).resolveAudio!()).toBeUndefined();
    // All three *desktop* retries remain, across VNC, D-Bus and XFCE exits.
    for (const [index, nextCount] of [
      [0, 12],
      [10, 16],
      [15, 20],
    ] as const) {
      fake.exit(index);
      await fake.afterSpawn(nextCount);
      expect(desktop.status().state).toBe("running");
    }
    expect(lease.isCurrent()).toBe(false);
    expect(onStop).toHaveBeenCalledOnce();
    fake.exit(16, "VNC failed again");
    await failed.promise;
    expect(desktop.status()).toMatchObject({
      state: "failed",
      error: expect.stringContaining("VNC failed again"),
    });
    expect(onFailed).toHaveBeenCalledOnce();
    expect(fake.runs.every((run) => run.settled)).toBe(true);
  });

  it("keeps audio retries independent of desktop failures and expires them after five minutes", async () => {
    const createAudio: typeof createManagedLinuxAudio = (params) =>
      createManagedLinuxAudio({ ...params, runtime: { detectBinary: async () => true } });
    const { desktop, fake, advanceTime } = await createFixture(createAudio);
    const acquired = await desktop.acquire();
    for (const index of [0, 4, 8]) {
      fake.exit(index);
      await fake.afterSpawn(index + 8);
    }
    const lease = await desktop.acquireComputer({ onStop: async () => undefined });
    for (const index of [13, 16, 17]) {
      fake.exit(index);
      await fake.afterSpawn(Math.max(17, index + 2));
    }
    advanceTime(5 * 60_000);
    fake.exit(18);
    await fake.afterSpawn(20);
    expect(acquired.resolveAudio!()).toBeDefined();
    expect(lease.isCurrent()).toBe(true);
  });

  it.each(["pulseaudio missing", "parec missing", "private server startup failed"])(
    "preserves inherited application and activation routing when %s",
    async (reason) => {
      const inherited = {
        PULSE_SERVER: "unix:/operator/pulse/native",
        PULSE_SINK: "operator-output",
        PULSE_SOURCE: "operator-input",
        PULSE_RUNTIME_PATH: "/operator/pulse",
        PULSE_STATE_PATH: "/operator/pulse/state",
        PULSE_CLIENTCONFIG: "/operator/pulse/client.conf",
      };
      for (const [key, value] of Object.entries(inherited)) {
        vi.stubEnv(key, value);
      }
      const createAudio: typeof createManagedLinuxAudio = () => {
        const stop = vi.fn(async () => undefined);
        return { ready: Promise.resolve({ unavailableReason: reason, stop }), stop };
      };
      const { desktop, fake } = await createFixture(createAudio);
      const acquired = await desktop.acquire();
      expect(acquired.resolveAudio?.()).toBeUndefined();
      expect(acquired.audioUnavailableReason).toBe(reason);
      for (const binary of ["dbus-daemon", "startxfce4"]) {
        expect(
          fake.inputs.find((input) => input.mode === "child" && input.argv[0] === binary)?.env,
        ).toMatchObject(inherited);
      }
      const lease = await desktop.acquireComputer({ onStop: async () => undefined });
      expect(lease.env).toMatchObject(inherited);
      expect(Object.isFrozen(lease.env)).toBe(true);
      expect(process.env).toMatchObject(inherited);
      lease.release();
    },
  );

  it("does not reuse a retired private audio environment when restart falls back", async () => {
    vi.stubEnv("PULSE_SERVER", "unix:/operator/pulse/native");
    vi.stubEnv("PULSE_SINK", "operator-output");
    let generation = 0;
    const createAudio: typeof createManagedLinuxAudio = () => {
      const stop = vi.fn(async () => undefined);
      const source =
        generation++ === 0
          ? {
              start: async () => {
                throw new Error("capture not requested");
              },
            }
          : undefined;
      return { ready: Promise.resolve({ source, stop }), stop };
    };
    const { desktop, fake } = await createFixture(createAudio);
    await desktop.acquire();
    const first = await desktop.acquireComputer({ onStop: async () => undefined });
    expect(first.env.PULSE_SERVER).not.toBe(process.env.PULSE_SERVER);
    fake.exit(0);
    await fake.afterSpawn(6);
    expect(first.isCurrent()).toBe(false);
    const next = await desktop.acquireComputer({ onStop: async () => undefined });
    expect(next.env.PULSE_SERVER).toBe(process.env.PULSE_SERVER);
    expect(next.env.PULSE_SINK).toBe(process.env.PULSE_SINK);
    expect((await desktop.acquire()).resolveAudio?.()).toBeUndefined();
    next.release();
  });

  it("starts private audio before apps and closes captures on desktop restart and stop", async () => {
    const createAudio: typeof createManagedLinuxAudio = (params) =>
      createManagedLinuxAudio({ ...params, runtime: { detectBinary: async () => true } });
    const { desktop, fake } = await createFixture(createAudio);
    const first = await desktop.acquire();
    expect(fake.inputs.map((input) => input.mode === "child" && input.argv[0])).toEqual([
      "Xtigervnc",
      "pulseaudio",
      "dbus-daemon",
      "startxfce4",
    ]);
    const computer = await desktop.acquireComputer({ onStop: async () => undefined });
    expect(computer.env.PULSE_SINK).toBe("openclaw_desktop");
    for (const binary of ["dbus-daemon", "startxfce4"]) {
      expect(
        fake.inputs.find((input) => input.mode === "child" && input.argv[0] === binary)?.env,
      ).toBe(computer.env);
    }
    computer.release();
    const source = first.resolveAudio!()!;
    const capture = await source.start(new AbortController().signal);
    fake.exit(0);
    await fake.afterSpawn(9);
    expect(capture.stream.destroyed).toBe(true);
    await expect(source.start(new AbortController().signal)).rejects.toThrow();
    const second = await desktop.acquire();
    expect(second.resolveAudio!()).not.toBe(source);
    expect(first.resolveAudio!()).toBe(second.resolveAudio!());
    const nextCapture = await first.resolveAudio!()!.start(new AbortController().signal);
    await desktop.stop();
    expect(nextCapture.stream.destroyed).toBe(true);
    expect(fake.runs.every((run) => run.settled)).toBe(true);
  });

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
    expect(computer.env.PULSE_SERVER).toBe(process.env.PULSE_SERVER);
    expect(computer.env.PULSE_SINK).toBe(process.env.PULSE_SINK);
    expect(acquired.resolveAudio?.()).toBeUndefined();
    expect(acquired.audioUnavailableReason).toBe("parec is not installed");
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
          createAudio: noAudio,
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
        createAudio: noAudio,
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
