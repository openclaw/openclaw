import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as retry from "../../../packages/retry/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as binaryDetection from "../../infra/detect-binary.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import type { BufferedCommandResult } from "../../process/exec.js";
import * as processExec from "../../process/exec.js";
import * as supervisorRuntime from "../../process/supervisor/index.js";
import type { ProcessSupervisor } from "../../process/supervisor/types.js";
import * as audioBridge from "./audio-bridge.js";
import { createDesktopSupervisor } from "./audio.test-support.js";
import { runExit } from "./computer.test-support.js";
import { createHostDesktopService } from "./host-source.js";
import { createManagedLinuxAudio } from "./managed-linux-audio.js";
import * as managedAudio from "./managed-linux-audio.js";
import { createManagedLinuxDesktop } from "./managed-linux.js";
import * as managedLinux from "./managed-linux.js";
import { releaseDesktopObserverToken } from "./observe-bridge.js";
import * as observeBridge from "./observe-bridge.js";
import * as rfbProbe from "./rfb-probe.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

vi.mock("../../infra/ports-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/ports-probe.js")>()),
  tryListenOnPort: async () => 45_999,
}));

const cleanups: Array<() => Promise<void>> = [];
const createAudioOwner = createManagedLinuxAudio;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const inheritedAudio = {
  PULSE_SERVER: "unix:/operator/pulse/native",
  PULSE_SINK: "operator-output",
  PULSE_SOURCE: "operator-input",
  PULSE_RUNTIME_PATH: "/operator/pulse",
  PULSE_STATE_PATH: "/operator/pulse/state",
  PULSE_CLIENTCONFIG: "/operator/pulse/client.conf",
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function passwordResult(missing = false): BufferedCommandResult {
  return {
    stdout: missing ? Buffer.alloc(0) : Buffer.from("12345678", "hex"),
    stderr: missing ? Buffer.from("spawn ENOENT") : Buffer.alloc(0),
    code: missing ? null : 0,
    signal: null,
    killed: false,
    termination: missing ? "error" : "exit",
  };
}

function createFakeSupervisor() {
  return createDesktopSupervisor(
    (input) => {
      if (input.argv[0] === "dbus-daemon") {
        input.onStdout?.(`${input.env?.DBUS_SESSION_BUS_ADDRESS},guid=fixture\n`);
      }
      if (input.argv[0] === "pulseaudio") {
        input.onStderr?.("Daemon startup complete.\n");
      }
      if (input.argv[0] === "parec") {
        input.onStdoutRaw?.(Buffer.alloc(4));
      }
    },
    runExit({ exitCode: 1, durationMs: 1 }),
  );
}

function audioResult(
  result: Omit<Awaited<ReturnType<typeof createManagedLinuxAudio>["ready"]>, "stop">,
) {
  const stop = vi.fn(async () => undefined);
  return { ready: Promise.resolve({ ...result, stop }), stop };
}
const noAudio: typeof createManagedLinuxAudio = (params) => {
  // Factories may consult admission before the asynchronous desktop pair exists.
  params.assertCurrent();
  return audioResult({ unavailableReason: "parec is not installed" });
};

function childInput(fake: ReturnType<typeof createFakeSupervisor>, index = 0) {
  const input = fake.inputs[index];
  if (input?.mode !== "child") {
    throw new Error("expected child process input");
  }
  return input;
}

function hostService(desktop: ReturnType<typeof createManagedLinuxDesktop>, connId: string) {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(managedLinux, "createManagedLinuxDesktop").mockReturnValue(desktop);
  const desktopProbe = vi.mocked(rfbProbe.probeRfbServer).getMockImplementation()!;
  const probe = vi.fn<typeof rfbProbe.probeRfbServer>().mockResolvedValue({ kind: "unreachable" });
  vi.spyOn(rfbProbe, "probeRfbServer").mockImplementation((params) =>
    params.port === 45_999 ? desktopProbe(params) : probe(params),
  );
  const registry = createDesktopSessionRegistry();
  cleanups.push(() => registry.stopAll());
  const service = createHostDesktopService({
    getConfig: () => ({ enabled: true, managed: true }),
    registry,
  });
  return { probe, registry, service, requester: { connId, isCurrent: () => true } };
}

const onStop = async () => undefined;
const signal = () => new AbortController().signal;

function expectAppsRunning(fake: ReturnType<typeof createFakeSupervisor>) {
  expect([0, 2, 3].every((index) => !fake.runs[index]!.activity.resultSettled)).toBe(true);
}

function expectStopped(fake: ReturnType<typeof createFakeSupervisor>) {
  expect(fake.runs.every((run) => run.activity.resultSettled)).toBe(true);
}

function heldAudioGeneration(generationToHold: number) {
  const entered = createDeferred();
  const admission = createDeferred();
  let generation = 0;
  const createAudio: typeof createManagedLinuxAudio = (params) => {
    const held = ++generation === generationToHold;
    vi.spyOn(binaryDetection, "detectBinary").mockImplementation(async () => {
      if (held) {
        entered.resolve();
        await admission.promise;
      }
      return true;
    });
    return createAudioOwner(params);
  };
  return { entered, admission, createAudio };
}

async function createFixture(createAudio = noAudio, onFailed?: (error: string) => void) {
  const root = tempDirs.make("openclaw-managed-linux-test-");
  const x11SocketDir = path.join(root, "x11");
  await fs.mkdir(x11SocketDir);
  const unixSocketTable = path.join(root, "unix");
  const fake = createFakeSupervisor();
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(supervisorRuntime, "getProcessSupervisor").mockReturnValue(fake.supervisor);
  vi.spyOn(managedAudio, "createManagedLinuxAudio").mockImplementation(createAudio);
  vi.spyOn(binaryDetection, "detectBinary").mockResolvedValue(true);
  vi.spyOn(retry, "sleepWithAbort").mockImplementation(async (ms) => {
    now += ms;
  });
  const runPasswordTool = vi
    .spyOn(processExec, "runCommandBuffered")
    .mockResolvedValue(passwordResult());
  const probeRfb = vi
    .fn<typeof rfbProbe.probeRfbServer>()
    .mockResolvedValueOnce({ kind: "unreachable" as const })
    .mockResolvedValue({ kind: "rfb" as const, securityTypes: [2] });
  vi.spyOn(rfbProbe, "probeRfbServer").mockImplementation(probeRfb);
  const makeDesktop = () =>
    createManagedLinuxDesktop({
      onFailed,
      runtime: {
        tempRoot: root,
        unixSocketTable,
        x11SocketDir,
      },
    });
  const desktop = makeDesktop();
  cleanups.push(() => desktop.stop());
  return {
    desktop,
    makeDesktop,
    fake,
    probeRfb,
    root,
    runPasswordTool,
    unixSocketTable,
    x11SocketDir,
    advanceTime: (ms: number) => {
      now += ms;
    },
  };
}

describe("managed Linux desktop", () => {
  it.each([0, 1])(
    "refreshes audio through the cached host acquisition after process %s exits",
    async (processIndex) => {
      const { desktop, fake } = await createFixture(createAudioOwner);
      const { probe, registry, service, requester } = hostService(desktop, "restart-viewer");
      const minted = vi.spyOn(audioBridge, "mintDesktopAudioObserver");
      const first = await service.observe({ control: true, requester });
      const acquired = await desktop.acquire();
      expect(fake.inputs.map((input) => input.mode === "child" && input.argv[0])).toEqual([
        "Xtigervnc",
        "pulseaudio",
        "dbus-daemon",
        "startxfce4",
      ]);
      const stopped = vi.fn(onStop);
      const lease = await desktop.acquireComputer({ onStop: stopped });
      expect(lease.env.PULSE_SINK).toBe("openclaw_desktop");
      for (const binary of ["dbus-daemon", "startxfce4"]) {
        expect(
          fake.inputs.find((input) => input.mode === "child" && input.argv[0] === binary)?.env,
        ).toBe(lease.env);
      }
      if (processIndex === 0) {
        lease.release();
      }
      const firstSource = minted.mock.calls[0]![0].source;
      const firstCapture = await firstSource.start(signal());
      await fake.restart(processIndex, processIndex === 0 ? 9 : 6);
      expect(firstCapture.stream.destroyed).toBe(true);
      if (processIndex === 1) {
        expect(lease.isCurrent()).toBe(true);
        expect(stopped).not.toHaveBeenCalled();
        expectAppsRunning(fake);
        expect(fake.inputs[5]!.env?.PULSE_SERVER).toBe(lease.env.PULSE_SERVER);
      }
      const second = await service.observe({ control: true, requester });
      const nextSource = minted.mock.calls[1]![0].source;
      expect(nextSource).not.toBe(firstSource);
      expect(acquired.resolveAudio!()).toBe(nextSource);
      expect(acquired.resolveAudio!()).toBe((await desktop.acquire()).resolveAudio!());
      await expect(firstSource.start(signal())).rejects.toThrow();
      const capture = await nextSource.start(signal());
      expect(probe).toHaveBeenCalledTimes(1);
      await releaseDesktopObserverToken(first.wsPath, requester);
      await releaseDesktopObserverToken(second.wsPath, requester);
      await registry.stopAll();
      expect(capture.stream.destroyed).toBe(true);
      if (processIndex === 1) {
        expect(stopped).toHaveBeenCalledOnce();
      }
      expectStopped(fake);
    },
  );

  it("leaves audio unavailable without replacing healthy apps when recovery cannot start", async () => {
    vi.stubEnv("PULSE_SERVER", "unix:/operator/pulse/native");
    const recoveryFinished = createDeferred();
    let available = true;
    const createAudio: typeof createManagedLinuxAudio = (params) => {
      vi.spyOn(binaryDetection, "detectBinary").mockImplementation(async () => available);
      const owner = createAudioOwner(params);
      if (!available) {
        void owner.ready.then(() => setImmediate(() => recoveryFinished.resolve()));
      }
      return owner;
    };
    const onFailed = vi.fn();
    const { desktop, fake } = await createFixture(createAudio, onFailed);
    const acquired = await desktop.acquire();
    const source = acquired.resolveAudio!()!;
    const capture = await source.start(signal());
    const stopped = vi.fn(onStop);
    const lease = await desktop.acquireComputer({ onStop: stopped });
    available = false;
    fake.exit(1);
    await recoveryFinished.promise;
    expect([desktop.status().state, lease.isCurrent()]).toEqual(["running", true]);
    expect([stopped.mock.calls, onFailed.mock.calls]).toEqual([[], []]);
    expectAppsRunning(fake);
    expect(fake.inputs).toHaveLength(5);
    expect(capture.stream.destroyed).toBe(true);
    expect(acquired.resolveAudio!()).toBeUndefined();
    expect(acquired.audioUnavailableReason).toContain("not installed");
    expect(acquired.audioUnavailableReason).toContain(
      "restart the managed desktop if audio is needed",
    );
    await expect(source.start(signal())).rejects.toThrow();
    const next = await desktop.acquireComputer({ onStop });
    expect(next.env).toBe(lease.env);
    expect(next.env.PULSE_SERVER).not.toBe(process.env.PULSE_SERVER);
    await desktop.stop();
    expect(stopped).toHaveBeenCalledOnce();
    expectStopped(fake);
  });

  it.each(["stop", "desktop exit"])("joins pending audio recovery on %s", async (event) => {
    const { entered, admission, createAudio } = heldAudioGeneration(2);
    cleanups.push(async () => admission.resolve());
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
      expectStopped(fake);
    } else {
      fake.exit(0);
      admission.resolve();
      await fake.afterSpawn(8);
      expect(desktop.status().state).toBe("running");
      expect(acquired.resolveAudio!()).toBeDefined();
    }
    await expect(source.start(signal())).rejects.toThrow();
  });

  it("exhausts only the audio budget and preserves the independent desktop budget", async () => {
    const audioStopped = createDeferred();
    const failed = createDeferred();
    const onFailed = vi.fn(() => failed.resolve());
    let generation = 0;
    const createAudio: typeof createManagedLinuxAudio = (params) => {
      const owner = createAudioOwner(params);
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
    const stopped = vi.fn(onStop);
    const lease = await desktop.acquireComputer({ onStop: stopped });
    const original = acquired.resolveAudio!()!;
    for (const index of [1, 4, 5]) {
      await fake.restart(index, Math.max(5, index + 2));
    }
    const lastSource = acquired.resolveAudio!()!;
    const capture = await lastSource.start(signal());
    fake.exit(6);
    await audioStopped.promise;
    expect([desktop.status().state, lease.isCurrent()]).toEqual(["running", true]);
    expect([stopped.mock.calls, onFailed.mock.calls]).toEqual([[], []]);
    expectAppsRunning(fake);
    expect(fake.inputs).toHaveLength(8);
    expect(capture.stream.destroyed).toBe(true);
    expect(acquired.resolveAudio!()).toBeUndefined();
    expect(acquired.audioUnavailableReason).toContain("3 restarts within 5 minutes");
    expect(acquired.audioUnavailableReason).toContain(
      "restart the managed desktop if audio is needed",
    );
    await expect(original.start(signal())).rejects.toThrow();
    await expect(lastSource.start(signal())).rejects.toThrow();
    expect((await desktop.acquire()).resolveAudio!()).toBeUndefined();
    // All three *desktop* retries remain, across VNC, D-Bus and XFCE exits.
    for (const [index, nextCount] of [
      [0, 12],
      [10, 16],
      [15, 20],
    ] as const) {
      await fake.restart(index, nextCount);
      expect(fake.inputs).toHaveLength(nextCount);
      expect(desktop.status().state).toBe("running");
    }
    expect(lease.isCurrent()).toBe(false);
    expect(stopped).toHaveBeenCalledOnce();
    fake.exit(16, "detail line\nlast stderr line\n");
    await failed.promise;
    expect(desktop.status()).toMatchObject({
      state: "failed",
      error: expect.stringContaining("last stderr line"),
      display: 99,
      port: 45_999,
    });
    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining("3 restarts within 5 minutes"));
    expectStopped(fake);
  });

  it("keeps audio retries independent of desktop failures and expires them after five minutes", async () => {
    const { desktop, fake, advanceTime } = await createFixture(createAudioOwner);
    const acquired = await desktop.acquire();
    for (const index of [0, 4, 8]) {
      await fake.restart(index, index + 8);
    }
    const lease = await desktop.acquireComputer({ onStop });
    for (const index of [13, 16, 17]) {
      await fake.restart(index, Math.max(17, index + 2));
    }
    advanceTime(5 * 60_000);
    await fake.restart(18, 20);
    expect(acquired.resolveAudio!()).toBeDefined();
    expect(lease.isCurrent()).toBe(true);
  });

  it("rejects cached host observation during held generation startup before minting grants", async () => {
    const { admission, entered, createAudio } = heldAudioGeneration(2);
    const { desktop, fake } = await createFixture(createAudio);
    const { probe, registry, service, requester } = hostService(desktop, "held-restart-viewer");
    const minted = vi.spyOn(observeBridge, "mintDesktopObserverToken");
    const mintedAudio = vi.spyOn(audioBridge, "mintDesktopAudioObserver");
    cleanups.push(async () => admission.resolve());
    const first = await service.observe({ control: true, requester });
    const acquired = await desktop.acquire();
    await releaseDesktopObserverToken(first.wsPath, requester);
    fake.exit(0);
    await entered.promise;
    // VNC is already serving; the private route and XFCE pair are still starting.
    expect(desktop.status().state).toBe("starting");
    await expect(service.observe({ control: true, requester })).rejects.toThrow(
      "is restarting; retry when it is ready",
    );
    expect(minted).toHaveBeenCalledTimes(1);
    expect(mintedAudio).toHaveBeenCalledTimes(1);
    admission.resolve();
    await fake.afterSpawn(8);
    const fresh = await service.observe({ control: true, requester });
    expect(fresh.audio).toBeDefined();
    expect(fresh.audioUnavailableReason).toBeUndefined();
    expect(minted).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(1);
    await releaseDesktopObserverToken(fresh.wsPath, requester);
    await registry.stopAll();
    expect(acquired.resolveAudio!()).toBeUndefined();
  });

  it.each(["pulseaudio", "parec"])(
    "reports current %s setup failure through cached host observations",
    async (missing) => {
      let unavailable = true;
      const { desktop, fake } = await createFixture(createAudioOwner);
      vi.spyOn(binaryDetection, "detectBinary").mockImplementation(
        async (binary) => !unavailable || binary !== missing,
      );
      const { probe, service, requester } = hostService(desktop, "setup-viewer");
      const first = await service.observe({ control: false, requester });
      expect(first.audio).toBeUndefined();
      expect(first.audioUnavailableReason).toBe("setup-unavailable");
      expect(JSON.stringify(first)).not.toContain(missing);
      await releaseDesktopObserverToken(first.wsPath, requester);
      unavailable = false;
      await fake.restart(0, 7);
      const second = await service.observe({ control: false, requester });
      expect(second.audio).toBeDefined();
      expect(second.audioUnavailableReason).toBeUndefined();
      await releaseDesktopObserverToken(second.wsPath, requester);
      unavailable = true;
      await fake.restart(3, 10);
      const third = await service.observe({ control: false, requester });
      expect(third.audio).toBeUndefined();
      expect(third.audioUnavailableReason).toBe("setup-unavailable");
      expect(probe).toHaveBeenCalledTimes(1);
      await releaseDesktopObserverToken(third.wsPath, requester);
    },
  );

  it("does not reuse a retired private audio environment when restart falls back", async () => {
    vi.stubEnv("PULSE_SERVER", "unix:/operator/pulse/native");
    vi.stubEnv("PULSE_SINK", "operator-output");
    let generation = 0;
    const source = {
      start: async () => {
        throw new Error("capture not requested");
      },
    };
    const createAudio: typeof createManagedLinuxAudio = () =>
      audioResult({ source: generation++ === 0 ? source : undefined });
    const { desktop, fake } = await createFixture(createAudio);
    await desktop.acquire();
    const first = await desktop.acquireComputer({ onStop });
    expect(first.env.PULSE_SERVER).not.toBe(process.env.PULSE_SERVER);
    await fake.restart(0, 6);
    expect(first.isCurrent()).toBe(false);
    const next = await desktop.acquireComputer({ onStop });
    expect(next.env).toMatchObject({
      PULSE_SERVER: process.env.PULSE_SERVER,
      PULSE_SINK: process.env.PULSE_SINK,
    });
    expect((await desktop.acquire()).resolveAudio?.()).toBeUndefined();
    next.release();
  });

  it("starts lazily with the exact TigerVNC recipe and a private ephemeral password", async () => {
    vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/unrelated/bus");
    for (const [key, value] of Object.entries(inheritedAudio)) {
      vi.stubEnv(key, value);
    }
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

    const vncInput = childInput(fake);
    const busInput = childInput(fake, 1);
    const sessionInput = childInput(fake, 2);
    const passwordFile = vncInput.argv[vncInput.argv.indexOf("-PasswordFile") + 1];
    if (!passwordFile) {
      throw new Error("expected password file argument");
    }
    expect(
      vncInput.argv.map((value) => (value === passwordFile ? "<password-file>" : value)),
    ).toEqual(
      (
        "Xtigervnc :99 -geometry 1920x1080 -depth 24 -localhost yes -rfbport 45999 " +
        "-SecurityTypes VncAuth -PasswordFile <password-file> " +
        "-AlwaysShared -AcceptSetDesktopSize -nolisten tcp -ac"
      ).split(" "),
    );
    expect(sessionInput.argv).toEqual(["startxfce4"]);
    expect(sessionInput.env?.DISPLAY).toBe(":99");
    expect(busInput.env).toMatchObject(inheritedAudio);
    expect(sessionInput.env).toMatchObject(inheritedAudio);
    const busAddress = `unix:path=${path.join(path.dirname(passwordFile), "bus")}`;
    expect(busInput.argv).toEqual([
      ..."dbus-daemon --session --nofork --nopidfile --print-address=1".split(" "),
      `--address=${busAddress}`,
    ]);
    const computer = await desktop.acquireComputer({ onStop });
    expect(computer.env).toEqual(sessionInput.env);
    expect(computer.env).toMatchObject({
      DBUS_SESSION_BUS_ADDRESS: busAddress,
      XDG_SESSION_TYPE: "x11",
      ...inheritedAudio,
    });
    expect(computer.env.WAYLAND_DISPLAY).toBeUndefined();
    expect(acquired.resolveAudio?.()).toBeUndefined();
    expect(acquired.audioUnavailableReason).toBe("parec is not installed");
    expect(Object.isFrozen(computer.env)).toBe(true);
    expect(process.env).toMatchObject(inheritedAudio);
    expect(process.env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/unrelated/bus");
    expect((await fs.stat(passwordFile)).mode & 0o777).toBe(0o600);
    await expect(fs.stat(path.join(path.dirname(passwordFile), "password.txt"))).rejects.toThrow();

    await desktop.stop();
    await expect(fs.stat(path.dirname(passwordFile))).rejects.toThrow();
    expect(desktop.status()).toEqual({ state: "not-started" });
    expect(passwordFile.startsWith(root)).toBe(true);
  });

  it.each([
    { mode: "socket files", occupied: [99, 100], display: ":101" },
    { mode: "kernel sockets", occupied: [101], display: ":102" },
    { mode: "unreadable kernel table", occupied: [99], display: ":100" },
  ])(
    "chooses the first free display using $mode and renews the password",
    async ({ mode, occupied, display }) => {
      const { desktop, fake, unixSocketTable, x11SocketDir } = await createFixture();
      await Promise.all(
        occupied.map((number) => fs.writeFile(path.join(x11SocketDir, `X${number}`), "")),
      );
      if (mode === "kernel sockets") {
        const socket = (inode: number, location = "") =>
          `0000000000000000: 00000002 00000000 00010000 0001 01 ${inode} ${location}`;
        await fs.writeFile(
          unixSocketTable,
          [
            "Num       RefCount Protocol Flags    Type St Inode Path",
            socket(145571, `@${x11SocketDir}/X99`),
            socket(145572, `${x11SocketDir}/X100`),
            "0000000000000000: 00000003 00000000 00000000 0001 03 144840",
            socket(145573, `@${x11SocketDir}-other/X102`),
            "",
          ].join("\n"),
        );
      } else if (mode === "unreadable kernel table") {
        await fs.mkdir(unixSocketTable);
      }
      const first = await desktop.acquire();
      expect(childInput(fake).argv[1]).toBe(display);
      await desktop.stop();
      if (mode === "socket files") {
        const second = await desktop.acquire();
        expect(second.vncPassword).not.toBe(first.vncPassword);
        await desktop.stop();
      }
    },
  );

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
      vi.spyOn(supervisorRuntime, "getProcessSupervisor").mockReturnValue(supervisor);
      fixture.probeRfb.mockReset().mockResolvedValue({ kind: "rfb", securityTypes: [2] });
      if (missingBinary === "tigervncpasswd") {
        fixture.runPasswordTool.mockResolvedValue(passwordResult(true));
      }
      const desktop = fixture.makeDesktop();

      await expect(desktop.acquire()).rejects.toThrow(missingBinary);
      await expect(desktop.acquire()).rejects.toThrow(
        "apt install tigervnc-standalone-server tigervnc-tools xfce4-session",
      );
      await desktop.stop();
    },
  );

  it.each(["stop", 0, 1, 2] as const)(
    "joins computer cleanup before retiring its desktop (%s)",
    async (event) => {
      const { desktop, fake } = await createFixture();
      await desktop.acquire();
      const cleanup = createDeferred();
      cleanups.push(async () => cleanup.resolve());
      const stopStarted = createDeferred();
      const stoppedComputer = vi.fn(async () => {
        stopStarted.resolve();
        await cleanup.promise;
      });
      const previous = await desktop.acquireComputer({ onStop: stoppedComputer });
      let stopped: Promise<void> | undefined;
      if (event === "stop") {
        stopped = desktop.stop();
        expect(desktop.stop()).toBe(stopped);
        expect(previous.isCurrent()).toBe(false);
      } else {
        fake.exit(event);
      }
      await stopStarted.promise;
      expect(stoppedComputer).toHaveBeenCalledOnce();
      expect(previous.isCurrent()).toBe(false);
      if (event === "stop") {
        expect(fake.runs.every((run) => !run.activity.resultSettled)).toBe(true);
      } else {
        expect(fake.runs.filter((run) => !run.activity.resultSettled)).toHaveLength(2);
      }
      expect(fake.inputs).toHaveLength(3);
      await expect(desktop.acquireComputer({ onStop: stoppedComputer })).rejects.toThrow(
        "unavailable",
      );
      cleanup.resolve();
      if (event === "stop") {
        await stopped;
        expectStopped(fake);
        expect(stoppedComputer).toHaveBeenCalledOnce();
        return;
      }
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
});
