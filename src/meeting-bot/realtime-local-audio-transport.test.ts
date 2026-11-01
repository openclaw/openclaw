import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStdin, type TestStdin } from "./audio-backend.test-support.js";
import { createLocalMeetingRealtimeAudioTransport } from "./realtime-local-audio-transport.js";

function createProcess(params: { stdin?: TestStdin | null; stdout?: EventEmitter | null }) {
  const events = new EventEmitter();
  const proc = Object.assign(events, {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: params.stdin ?? null,
    stdout: params.stdout ?? null,
    stderr: new PassThrough(),
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      proc.signalCode = signal;
      queueMicrotask(() => {
        proc.stdin?.emit("close");
        events.emit("exit", null, signal);
      });
      return true;
    }),
  });
  return proc;
}

function createTransportWith(
  overrides: Partial<Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]> = {},
) {
  return createLocalMeetingRealtimeAudioTransport({
    bargeInCooldownMs: 0,
    bargeInPeakThreshold: 0,
    bargeInRmsThreshold: 0,
    inputCommand: ["capture"],
    logger: { debug: vi.fn(), warn: vi.fn() } as never,
    logScope: "[meeting]",
    outputCommand: ["play"],
    ...overrides,
  });
}

function createTransport(
  outputStdin = createStdin(true, true),
  overrides: Partial<Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]> = {},
) {
  const output = createProcess({ stdin: outputStdin });
  const input = createProcess({ stdout: new EventEmitter() });
  const replacementOutput = createProcess({ stdin: createStdin(true, true) });
  const spawn = vi.fn().mockReturnValueOnce(output).mockReturnValueOnce(input);
  spawn.mockReturnValueOnce(replacementOutput);
  const transport = createTransportWith({ spawn: spawn as never, ...overrides });
  return { replacementOutput, spawn, transport };
}

describe("local meeting realtime audio transport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stops output after input spawn throws even when output spawn failed", () => {
    const output = createProcess({ stdin: createStdin(true, true) });
    output.kill.mockReturnValueOnce(false);
    const failure = new Error("input spawn failed");
    const spawn = vi
      .fn()
      .mockReturnValueOnce(output)
      .mockImplementationOnce(() => {
        throw failure;
      });

    expect(() => createTransportWith({ spawn: spawn as never })).toThrow(failure);
    expect(output.kill).toHaveBeenCalledWith("SIGTERM");
    expect(() => output.emit("error", new Error("output spawn failed"))).not.toThrow();
  });

  it("keeps empty barge-in validation lazy until monitoring starts", async () => {
    const { spawn, transport } = createTransport(undefined, { bargeInInputCommand: [] });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(() => transport.startBargeInMonitor?.(() => false)).toThrow(
      "audio bridge command must not be empty",
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    await transport.stop();
  });

  it("releases a backpressured write on clear and ignores retired output failures", async () => {
    const outputStdin = createStdin(false, true);
    const { replacementOutput, transport } = createTransport(outputStdin);
    const fatal = vi.fn();
    transport.onFatal(fatal);
    let settled = false;
    const writing = transport.writeOutput(Buffer.from([1, 2, 3])).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await transport.clearOutput();
    await writing;
    expect(settled).toBe(true);
    expect(replacementOutput.stdin?.write).not.toHaveBeenCalled();
    outputStdin.accept(new Error("retired output write failed"));
    await transport.writeOutput(Buffer.from([7, 8, 9]));
    expect(replacementOutput.stdin?.write).toHaveBeenCalledOnce();
    expect(fatal).not.toHaveBeenCalled();
    await transport.stop();
  });

  it("signals fatal and stops when the current output write throws", async () => {
    const outputStdin = createStdin(true, true);
    outputStdin.write.mockImplementation(() => {
      throw new Error("output write failed");
    });
    const { transport } = createTransport(outputStdin);
    const fatal = vi.fn();
    transport.onFatal?.(fatal);
    try {
      await expect(transport.writeOutput(Buffer.from([1, 2, 3]))).resolves.toBeUndefined();
      expect(fatal).toHaveBeenCalledOnce();
      await transport.writeOutput(Buffer.from([4, 5, 6]));
      expect(outputStdin.write).toHaveBeenCalledOnce();
    } finally {
      await transport.stop();
    }
  });

  it("preserves split UTF-8 diagnostics and logs complete fragments immediately", async () => {
    const processes = {
      play: createProcess({}),
      capture: createProcess({}),
      barge: createProcess({}),
    };
    const debug = vi.fn();
    const spawn = vi.fn((command: keyof typeof processes) => processes[command]);
    const transport = createTransportWith({
      inputCommand: ["capture", "--device", "input name", ""],
      logger: { debug, warn: vi.fn() } as never,
      outputCommand: ["play", "--device", "output name", ""],
      bargeInInputCommand: ["barge", "--device", "barge name", ""],
      spawn: spawn as never,
    });
    transport.startBargeInMonitor?.(() => false);

    expect(spawn.mock.calls).toEqual([
      ["play", ["--device", "output name", ""], { stdio: ["pipe", "ignore", "pipe"] }],
      ["capture", ["--device", "input name", ""], { stdio: ["ignore", "pipe", "pipe"] }],
      ["barge", ["--device", "barge name", ""], { stdio: ["ignore", "pipe", "pipe"] }],
    ]);

    for (const [command, label] of [
      ["play", "audio output"],
      ["capture", "audio input"],
      ["barge", "barge-in input"],
    ] as const) {
      const process = processes[command];
      const diagnostic = `诊断-${command}`;
      const line = Buffer.from(`${diagnostic}\n`, "utf8");
      const before = debug.mock.calls.length;
      process.stderr.write(line.subarray(0, 2));
      expect(debug).toHaveBeenCalledTimes(before);
      process.stderr.write(line.subarray(2, -1));
      expect(debug).toHaveBeenNthCalledWith(before + 1, `[meeting] ${label}: ${diagnostic}`);
      process.stderr.write(line.subarray(-1));

      process.stderr.write(Buffer.from(`未换行-${command}`, "utf8"));
      expect(debug).toHaveBeenNthCalledWith(before + 2, `[meeting] ${label}: 未换行-${command}`);
    }

    await transport.stop();
  });
});
