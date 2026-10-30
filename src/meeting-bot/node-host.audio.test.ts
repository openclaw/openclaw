import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));
const cryptoMocks = vi.hoisted(() => ({
  randomUUID: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcessMocks.spawn,
  spawnSync: childProcessMocks.spawnSync,
}));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: cryptoMocks.randomUUID,
}));

import { createStdin, type TestStdin } from "./audio-backend.test-support.js";
import { createMeetingNodeHost, type MeetingNodeHostOptions } from "./node-host.js";

const TEST_UUID = "00000000-0000-4000-8000-000000000001";
// Mirrors the node-host's private retention limits.
const MAX_QUEUED_INPUT_CHUNKS = 200;
const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;
const AUDIO_START_PARAMS = {
  action: "start",
  audioInputCommand: ["capture"],
  audioOutputCommand: ["play"],
  mode: "bidi",
} as const;
const PREPARED_AUDIO = {
  backend: "pipewire-pulse" as const,
  deviceLabel: "OpenClaw Meeting Audio",
  inputCommand: ["parec"],
  outputCommand: ["pacat"],
};
const FIRST_AUDIO = Buffer.from([1, 2, 3]);
const FINAL_AUDIO = Buffer.from([4, 5, 6]);

function createProcess(params: {
  stdin?: TestStdin | null;
  stdout?: EventEmitter | null;
  autoClose?: boolean;
}) {
  const events = new EventEmitter();
  const proc = Object.assign(events, {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: params.stdin ?? null,
    stdout: params.stdout ?? null,
    stderr: new EventEmitter(),
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      proc.signalCode = signal;
      queueMicrotask(() => {
        events.emit("exit", null, signal);
        if (params.autoClose !== false) {
          params.stdout?.emit("end");
          params.stdout?.emit("close");
          events.emit("close", null, signal);
        }
      });
      return true;
    }),
  });
  return proc;
}

function createHost(overrides: Partial<MeetingNodeHostOptions> = {}) {
  return createMeetingNodeHost({
    agentMode: "agent",
    assertAudioAvailable: vi.fn(),
    bridgeIdPrefix: "test-bridge-",
    browser: {
      application: "Test Browser",
      buildProfileArgs: () => [],
      openedNotes: [],
      openedStatus: "opened",
    },
    browserLabel: "Test Browser",
    commandName: "meeting.chrome",
    defaultAudioInputCommand: ["capture"],
    defaultAudioOutputCommand: ["play"],
    displayName: "Test Meeting",
    normalizeMeetingKey: (url) => url,
    normalizeUrl: (input) => (typeof input === "string" ? input : "https://meeting.test"),
    talkBackModes: new Set(["bidi"]),
    ...overrides,
  });
}

async function invokeHost(
  host: ReturnType<typeof createHost>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return JSON.parse(await host.handleCommand(JSON.stringify(params))) as Record<string, unknown>;
}

async function startAudioBridge(
  options: {
    inputAutoClose?: boolean;
    outputStdin?: TestStdin;
    host?: Partial<MeetingNodeHostOptions>;
    start?: Record<string, unknown>;
  } = {},
) {
  const inputStdout = new EventEmitter();
  const inputProcess = createProcess({ stdout: inputStdout, autoClose: options.inputAutoClose });
  const outputStdin = options.outputStdin ?? createStdin(true);
  const outputProcess = createProcess({ stdin: outputStdin });
  childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
  const host = createHost(options.host);
  const started = await invokeHost(host, {
    ...AUDIO_START_PARAMS,
    launch: false,
    ...options.start,
  });
  return {
    started,
    bridgeId: started.bridgeId as string,
    host,
    inputProcess,
    inputStdout,
    outputProcess,
    outputStdin,
  };
}

function rpc(
  bridge: Pick<Bridge, "host" | "bridgeId">,
  action: "clearAudio" | "pullAudio" | "pushAudio" | "status" | "stop",
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return invokeHost(bridge.host, { action, bridgeId: bridge.bridgeId, ...params });
}

type Bridge = Awaited<ReturnType<typeof startAudioBridge>>;
const pushAudio = (bridge: Bridge, audio = FIRST_AUDIO, outputGeneration?: number) =>
  rpc(bridge, "pushAudio", { base64: audio.toString("base64"), outputGeneration });
const failCapture = (bridge: Bridge) =>
  bridge.inputProcess.stderr.emit("error", new Error("capture failed"));
function endCapture(bridge: Bridge) {
  bridge.inputStdout.emit("end");
  bridge.inputStdout.emit("close");
}
function queueTerminalAudio(bridge: Bridge) {
  bridge.inputStdout.emit("data", FIRST_AUDIO);
  bridge.inputStdout.emit("data", FINAL_AUDIO);
  failCapture(bridge);
}
const expectUnknown = (bridge: Bridge) =>
  expect(rpc(bridge, "pullAudio")).rejects.toThrow(`unknown bridgeId: ${bridge.bridgeId}`);
const expectPull = (bridge: Bridge, pulling: Promise<unknown>, closed: boolean, audio?: Buffer) =>
  expect(pulling).resolves.toEqual({
    bridgeId: bridge.bridgeId,
    closed,
    ...(audio ? { base64: audio.toString("base64") } : {}),
  });
const expectRetained = (bridge: Bridge) =>
  expect(rpc(bridge, "status")).resolves.toMatchObject({
    bridge: { bridgeId: bridge.bridgeId, closed: true, queuedInputChunks: 1 },
  });
const expectClosed = (bridge: Pick<Bridge, "host" | "bridgeId">) =>
  expect(rpc(bridge, "status")).resolves.toEqual({
    bridge: { bridgeId: bridge.bridgeId, closed: true },
  });
const replaceOutput = () => {
  const stdin = createStdin(true);
  childProcessMocks.spawn.mockReturnValueOnce(createProcess({ stdin }));
  return stdin;
};
const expectStopped = (bridge: Bridge, stopped: boolean) =>
  expect(rpc(bridge, "stop")).resolves.toEqual({ ok: true, stopped });
function pendingPush(bridge: Bridge) {
  let settled = false;
  const result = pushAudio(bridge, FIRST_AUDIO, 0).then((value) => {
    settled = true;
    return value;
  });
  return { result, isSettled: () => settled };
}

beforeEach(() => {
  cryptoMocks.randomUUID.mockReturnValue(TEST_UUID);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("meeting node host audio backend", () => {
  it("prepares the node-local backend and uses its generated command pair", async () => {
    const prepareAudio = vi.fn(async () => ({
      ...PREPARED_AUDIO,
      inputCommand: ["parec", "--device", "input name", ""],
      outputCommand: ["pacat", "--device", "output name", ""],
    }));
    const bridge = await startAudioBridge({
      host: { prepareAudio },
      start: {
        url: "https://meeting.test/linux",
        audioBackend: "auto",
        audioBufferBytes: 2_048,
        audioFormat: "g711-ulaw-8khz",
        audioInputCommand: ["trusted-capture"],
        audioOutputCommand: ["trusted-playback"],
      },
    });

    expect(prepareAudio).toHaveBeenCalledWith(
      {
        backend: "auto",
        bufferBytes: 2_048,
        format: "g711-ulaw-8khz",
        inputCommand: ["trusted-capture"],
        outputCommand: ["trusted-playback"],
        bargeInInputCommand: undefined,
      },
      10_000,
    );
    expect(childProcessMocks.spawn.mock.calls).toEqual([
      ["pacat", ["--device", "output name", ""], { stdio: ["pipe", "ignore", "pipe"] }],
      ["parec", ["--device", "input name", ""], { stdio: ["ignore", "pipe", "pipe"] }],
    ]);
    expect(bridge.started).toMatchObject({
      audioBackend: "pipewire-pulse",
      audioDeviceLabel: "OpenClaw Meeting Audio",
      audioBridge: { type: "node-command-pair" },
    });
    await rpc(bridge, "stop");
  });

  it("provisions audio before preserving the configured external bridge path", async () => {
    const events: string[] = [];
    const prepareAudio = vi.fn(async () => {
      events.push("prepare");
      return PREPARED_AUDIO;
    });
    childProcessMocks.spawnSync.mockImplementation(() => {
      events.push("bridge");
      return { error: undefined, signal: null, status: 0, stderr: "", stdout: "" };
    });
    const host = createHost({ prepareAudio });

    const started = await invokeHost(host, {
      action: "start",
      url: "https://meeting.test/external",
      mode: "bidi",
      launch: false,
      audioBridgeCommand: ["trusted-bridge", "start"],
    });

    expect(events).toEqual(["prepare", "bridge"]);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    expect(started).toMatchObject({
      audioBackend: "pipewire-pulse",
      audioBridge: { type: "external-command" },
    });
  });
});

describe("meeting node host audio output", () => {
  it("retains update ownership between RPCs and through child stream cleanup", async () => {
    const bridge = await startAudioBridge({ inputAutoClose: false });
    expect(bridge.host.hasActiveWork()).toBe(true);

    await rpc(bridge, "stop");
    expect(bridge.host.hasActiveWork()).toBe(true);
    bridge.inputProcess.emit("close", null, "SIGTERM");
    expect(bridge.host.hasActiveWork()).toBe(false);
  });

  it.each([
    ["chunks", 1, MAX_QUEUED_INPUT_CHUNKS],
    ["bytes", 64 * 1024, MAX_QUEUED_INPUT_BYTES / (64 * 1024)],
  ] as const)("keeps only the newest bounded input %s", async (_limit, chunkBytes, count) => {
    const bridge = await startAudioBridge();
    for (let value = 0; value <= count; value += 1) {
      bridge.inputStdout.emit("data", Buffer.alloc(chunkBytes, value));
    }
    await expect(rpc(bridge, "status")).resolves.toMatchObject({
      bridge: { queuedInputChunks: count },
    });
    const pulled = await rpc(bridge, "pullAudio");
    assert.deepStrictEqual(
      Buffer.from(pulled.base64 as string, "base64"),
      Buffer.alloc(chunkBytes, 1),
    );
    await rpc(bridge, "stop");
  });

  it("copies only the newest bytes from an oversized input chunk", async () => {
    const bridge = await startAudioBridge();
    const source = Buffer.allocUnsafe(MAX_QUEUED_INPUT_BYTES + 4);
    for (let index = 0; index < source.length; index += 1) {
      source[index] = index % 251;
    }
    const expected = Buffer.from(source.subarray(source.length - MAX_QUEUED_INPUT_BYTES));

    bridge.inputStdout.emit("data", source);
    source.fill(0);

    const pulled = await rpc(bridge, "pullAudio");
    assert.deepStrictEqual(Buffer.from(pulled.base64 as string, "base64"), expected);
    await rpc(bridge, "stop");
  });

  it("does not retain unrelated pool slabs while captured audio awaits a pull", async () => {
    const bridge = await startAudioBridge();
    const churn = "x".repeat(Buffer.poolSize / 2 - 8);
    const mark = () => {
      Buffer.from(churn);
      Buffer.from(churn);
      Buffer.from(churn);
      const before = Buffer.from("marker");
      const audio = Buffer.alloc(960, 7);
      bridge.inputStdout.emit("data", audio);
      audio.fill(0);
      const after = Buffer.from("marker");
      return [new WeakRef(before.buffer), new WeakRef(after.buffer)];
    };
    const references = Array.from({ length: 8 }, mark).flat();
    Buffer.from(churn);
    Buffer.from(churn);
    Buffer.from(churn);
    const control = new WeakRef({});
    await nextTurn();
    queryObjects(WeakRef);
    try {
      expect(control.deref()).toBeUndefined();
      expect(references.filter((reference) => reference.deref() !== undefined)).toHaveLength(0);
      const pulled = await rpc(bridge, "pullAudio");
      expect(Buffer.from(pulled.base64 as string, "base64")).toEqual(Buffer.alloc(960, 7));
    } finally {
      await rpc(bridge, "stop");
    }
  });

  it.each([
    ["empty", undefined, 0],
    ["queued audio", FIRST_AUDIO, 0],
    ["stdout flushed after 250ms", FINAL_AUDIO, 300],
  ] as const)("delivers terminal close with %s to a pending pull", async (_name, audio, delay) => {
    if (delay) {
      vi.useFakeTimers();
    }
    const bridge = await startAudioBridge({ inputAutoClose: !delay });
    const pulling = rpc(bridge, "pullAudio", { timeoutMs: 2_000 });
    if (audio && !delay) {
      bridge.inputStdout.emit("data", FIRST_AUDIO);
    }
    failCapture(bridge);
    if (delay) {
      await vi.advanceTimersByTimeAsync(delay);
      bridge.inputStdout.emit("data", audio);
      endCapture(bridge);
    }
    await expectPull(bridge, pulling, true, audio);
    await vi.waitFor(() => expectClosed(bridge));
    await expectUnknown(bridge);
    expect(bridge.outputProcess.kill).toHaveBeenCalledTimes(1);
    expect(bridge.inputProcess.kill).toHaveBeenCalledTimes(1);
  });

  it("blocks output commands as soon as terminal teardown starts", async () => {
    const bridge = await startAudioBridge({
      inputAutoClose: false,
      outputStdin: createStdin(false),
    });
    const { bridgeId } = bridge;
    const pushing = pushAudio(bridge, FIRST_AUDIO, 0);
    await nextTurn();

    failCapture(bridge);

    await expect(pushing).resolves.toEqual({ bridgeId, ok: true, stale: true });
    await expect(pushAudio(bridge, FINAL_AUDIO, 0)).rejects.toThrow(
      `bridge is not open: ${bridgeId}`,
    );
    await expect(rpc(bridge, "clearAudio", { outputGeneration: 1 })).rejects.toThrow(
      `bridge is not open: ${bridgeId}`,
    );
    await expect(rpc(bridge, "status")).resolves.toMatchObject({
      bridge: { bridgeId, closed: true },
    });
    await expect(
      invokeHost(bridge.host, {
        action: "list",
        url: "https://meeting.test",
        mode: "bidi",
      }),
    ).resolves.toEqual({ bridges: [] });
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);

    endCapture(bridge);
    await expectStopped(bridge, false);
  });

  it("drains final audio when input closes between sequential pulls", async () => {
    const bridge = await startAudioBridge();
    queueTerminalAudio(bridge);
    await Promise.resolve();

    await expectPull(bridge, rpc(bridge, "pullAudio"), false, FIRST_AUDIO);
    await expectPull(bridge, rpc(bridge, "pullAudio"), true, FINAL_AUDIO);
    await vi.waitFor(() => expectUnknown(bridge));
  });

  it.each(["capture drain", "pull progress"] as const)(
    "starts eviction after %s",
    async (activity) => {
      vi.useFakeTimers();
      const bridge = await startAudioBridge({ inputAutoClose: activity !== "capture drain" });
      queueTerminalAudio(bridge);
      if (activity === "pull progress") {
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(4_000);
      }
      await expectPull(bridge, rpc(bridge, "pullAudio"), false, FIRST_AUDIO);
      if (activity === "capture drain") {
        await vi.advanceTimersByTimeAsync(3_000);
        endCapture(bridge);
        await vi.advanceTimersByTimeAsync(2_100);
        await expectRetained(bridge);
      }
      await vi.advanceTimersByTimeAsync(activity === "capture drain" ? 2_899 : 4_999);
      await expectRetained(bridge);
      await vi.advanceTimersByTimeAsync(1);
      await expectUnknown(bridge);
    },
  );

  it("clears and deletes input retention on explicit stop", async () => {
    const bridge = await startAudioBridge();
    bridge.inputStdout.emit("data", Buffer.alloc(64 * 1024));

    await expectStopped(bridge, true);
    await expectStopped(bridge, false);
    await expectUnknown(bridge);
  });

  it("terminates output when input construction and output spawn fail", async () => {
    const outputProcess = createProcess({ stdin: createStdin(true), autoClose: false });
    outputProcess.kill.mockReturnValueOnce(false);
    const spawnError = new Error("input spawn failed");
    childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockImplementationOnce(() => {
      throw spawnError;
    });
    const host = createHost();

    await expect(invokeHost(host, { ...AUDIO_START_PARAMS, launch: false })).rejects.toBe(
      spawnError,
    );
    expect(outputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(() => outputProcess.emit("error", new Error("output spawn failed"))).not.toThrow();
    expect(host.hasActiveWork()).toBe(true);
    outputProcess.emit("close", null, "SIGTERM");
    expect(host.hasActiveWork()).toBe(false);
  });

  it("deletes a hidden audio session after browser launch fails", async () => {
    const inputProcess = createProcess({ stdout: new EventEmitter() });
    const outputProcess = createProcess({ stdin: createStdin(true) });
    childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
    childProcessMocks.spawnSync.mockReturnValue({
      error: undefined,
      signal: null,
      status: 1,
      stderr: "launch failed",
      stdout: "",
    });
    const host = createHost();
    const bridgeId = `test-bridge-${TEST_UUID}`;

    await expect(invokeHost(host, AUDIO_START_PARAMS)).rejects.toThrow(
      "failed to launch Chrome for Test Browser: launch failed",
    );
    await vi.waitFor(() => expectClosed({ host, bridgeId }));
    await expect(invokeHost(host, { action: "pullAudio", bridgeId })).rejects.toThrow(
      `unknown bridgeId: ${bridgeId}`,
    );
  });

  it("waits for the output stream to accept a backpressured chunk", async () => {
    const bridge = await startAudioBridge({ outputStdin: createStdin(false) });
    const { outputStdin } = bridge;

    const pushing = pendingPush(bridge);
    await nextTurn();
    expect(pushing.isSettled()).toBe(false);

    outputStdin.accept();
    await expect(pushing.result).resolves.toMatchObject({ ok: true });
    await rpc(bridge, "stop");
  });

  it("rejects output generations outside the safe integer range", async () => {
    const bridge = await startAudioBridge();

    await expect(
      rpc(bridge, "clearAudio", {
        outputGeneration: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("outputGeneration must be a non-negative integer");
    await rpc(bridge, "stop");
  });

  it("stops the current bridge when its output callback fails", async () => {
    const bridge = await startAudioBridge({ outputStdin: createStdin(false) });
    try {
      const pushing = pushAudio(bridge, FIRST_AUDIO, 0);
      const rejected = expect(pushing).rejects.toThrow(`bridge is not open: ${bridge.bridgeId}`);
      bridge.outputStdin.accept(new Error("output write failed"));
      await rejected;
      expect(bridge.outputProcess.kill).toHaveBeenCalledWith("SIGTERM");
      expect(bridge.inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await rpc(bridge, "stop");
    }
  });

  it("waits for output acceptance and rejects stale generations after clear", async () => {
    const bridge = await startAudioBridge({ outputStdin: createStdin(false) });
    const replacementStdin = replaceOutput();
    const { bridgeId } = bridge;
    const firstPush = pendingPush(bridge);
    await Promise.resolve();
    expect(firstPush.isSettled()).toBe(false);

    const cleared = await rpc(bridge, "clearAudio", { outputGeneration: 1 });
    expect(cleared).toMatchObject({ ok: true });
    await expect(firstPush.result).resolves.toMatchObject({ ok: true, stale: true });

    const stalePush = await pushAudio(bridge, FINAL_AUDIO, 0);
    expect(stalePush).toMatchObject({ ok: true, stale: true });
    expect(replacementStdin.write).not.toHaveBeenCalled();

    bridge.outputStdin.accept(new Error("retired output write failed"));
    await expect(pushAudio(bridge, Buffer.from([7, 8, 9]), 1)).resolves.toEqual({
      bridgeId,
      ok: true,
    });
    expect(replacementStdin.write).toHaveBeenCalledOnce();

    await rpc(bridge, "stop");
  });

  it("accepts legacy output commands and preserves their response shapes", async () => {
    const bridge = await startAudioBridge();
    const replacementStdin = replaceOutput();
    const { bridgeId } = bridge;

    await expect(pushAudio(bridge)).resolves.toEqual({ bridgeId, ok: true });
    await expect(rpc(bridge, "clearAudio")).resolves.toEqual({ bridgeId, ok: true, clearCount: 1 });
    await expect(pushAudio(bridge, FINAL_AUDIO)).resolves.toEqual({ bridgeId, ok: true });
    expect(bridge.outputStdin.write).toHaveBeenCalledOnce();
    expect(replacementStdin.write).toHaveBeenCalledOnce();

    await rpc(bridge, "stop");
  });
});
