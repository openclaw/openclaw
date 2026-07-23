import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLocalMeetingRealtimeAudioTransport } from "./realtime-local-audio-transport.js";

type MeetingRealtimeAudioSpawn = NonNullable<
  Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]["spawn"]
>;

type TestBridgeProcess = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>;
};

function createTestBridgeProcess(): TestBridgeProcess {
  const proc = new EventEmitter() as TestBridgeProcess;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn(() => true);
  return proc;
}

describe("createLocalMeetingRealtimeAudioTransport", () => {
  it("preserves split UTF-8 diagnostic lines for all local audio subprocesses", async () => {
    const processes = new Map<string, TestBridgeProcess>();
    const spawn = vi.fn<MeetingRealtimeAudioSpawn>((command) => {
      const proc = createTestBridgeProcess();
      processes.set(command, proc);
      return proc;
    });
    spawn.stderrLifecycle = "stream";
    const debug = vi.fn();
    const transport = createLocalMeetingRealtimeAudioTransport({
      inputCommand: ["input"],
      outputCommand: ["output"],
      bargeInInputCommand: ["barge-in"],
      bargeInRmsThreshold: 10,
      bargeInPeakThreshold: 10,
      bargeInCooldownMs: 1,
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logScope: "[meeting]",
      spawn,
    });
    transport.startBargeInMonitor?.(() => false);

    const cases = [
      { command: "output", label: "audio output" },
      { command: "input", label: "audio input" },
      { command: "barge-in", label: "barge-in input" },
    ];

    for (const { command, label } of cases) {
      const proc = processes.get(command);
      if (!proc) {
        throw new Error(`Expected ${command} process`);
      }
      const diagnostic = `诊断-${command}`;
      const line = Buffer.from(`${diagnostic}\n`, "utf8");
      const callsBeforeLine = debug.mock.calls.length;

      proc.stderr.write(line.subarray(0, 1));
      proc.stderr.write(line.subarray(1, -1));
      expect(debug).toHaveBeenCalledTimes(callsBeforeLine);

      proc.stderr.write(line.subarray(-1));
      expect(debug).toHaveBeenNthCalledWith(
        callsBeforeLine + 1,
        `[meeting] ${label}: ${diagnostic}`,
      );

      const unterminatedDiagnostic = `未换行-${command}`;
      proc.stderr.write(Buffer.from(unterminatedDiagnostic, "utf8"));
      expect(debug).toHaveBeenCalledTimes(callsBeforeLine + 1);

      proc.stderr.end();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(debug).toHaveBeenNthCalledWith(
        callsBeforeLine + 2,
        `[meeting] ${label}: ${unterminatedDiagnostic}`,
      );
    }

    expect(debug.mock.calls.length).toBeGreaterThanOrEqual(cases.length * 2);
  });

  it("bounds diagnostics and drains stderr without a debug logger", async () => {
    const withoutDebug = new Map<string, TestBridgeProcess>();
    const transportWithoutDebug = createLocalMeetingRealtimeAudioTransport({
      inputCommand: ["input"],
      outputCommand: ["output"],
      bargeInInputCommand: ["barge-in"],
      bargeInRmsThreshold: 10,
      bargeInPeakThreshold: 10,
      bargeInCooldownMs: 1,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logScope: "[meeting]",
      spawn: (command) => {
        const proc = createTestBridgeProcess();
        withoutDebug.set(command, proc);
        return proc;
      },
    });
    transportWithoutDebug.startBargeInMonitor?.(() => false);
    for (const proc of withoutDebug.values()) {
      expect(proc.stderr.listenerCount("data")).toBe(1);
      expect(proc.stderr.readableFlowing).toBe(true);
      for (let index = 0; index < 16; index += 1) {
        proc.stderr.write(Buffer.alloc(8 * 1024));
      }
      expect(proc.stderr.readableLength).toBe(0);
    }

    const processes = new Map<string, TestBridgeProcess>();
    const debug = vi.fn();
    const spawn = ((command: string) => {
      const proc = createTestBridgeProcess();
      processes.set(command, proc);
      return proc;
    }) as MeetingRealtimeAudioSpawn;
    spawn.stderrLifecycle = "stream";
    createLocalMeetingRealtimeAudioTransport({
      inputCommand: ["input"],
      outputCommand: ["output"],
      bargeInRmsThreshold: 10,
      bargeInPeakThreshold: 10,
      bargeInCooldownMs: 1,
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logScope: "[meeting]",
      spawn,
    });
    const outputProcess = processes.get("output");
    if (!outputProcess) {
      throw new Error("Expected output process");
    }

    outputProcess.stderr.write("progress\r");
    expect(debug).toHaveBeenCalledWith("[meeting] audio output: progress");
    outputProcess.stderr.write("\nnext\r\n");
    expect(debug).toHaveBeenNthCalledWith(2, "[meeting] audio output: next");
    expect(debug).toHaveBeenCalledTimes(2);

    const oversizedDiagnostic = "诊".repeat(3_000);
    outputProcess.stderr.write(`${oversizedDiagnostic}\n`);
    const completedMessage = debug.mock.calls.at(-1)?.[0];
    expect(completedMessage).toEqual(
      expect.stringMatching(/^\[meeting\] audio output: \[stderr line truncated\] 诊+$/u),
    );
    expect(Buffer.byteLength(completedMessage ?? "", "utf8")).toBeLessThanOrEqual(
      8 * 1024 + Buffer.byteLength("[meeting] audio output: [stderr line truncated] ", "utf8"),
    );
    expect(completedMessage).not.toContain("�");

    outputProcess.stderr.write(oversizedDiagnostic);
    outputProcess.stderr.end();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const trailingMessage = debug.mock.calls.at(-1)?.[0];
    expect(trailingMessage).toEqual(
      expect.stringMatching(/^\[meeting\] audio output: \[stderr line truncated\] 诊+$/u),
    );
    expect(Buffer.byteLength(trailingMessage ?? "", "utf8")).toBeLessThanOrEqual(
      8 * 1024 + Buffer.byteLength("[meeting] audio output: [stderr line truncated] ", "utf8"),
    );
    expect(trailingMessage).not.toContain("�");
  });

  it("flushes an injected stderr adapter when its child exits", async () => {
    const processes = new Map<string, TestBridgeProcess>();
    const debug = vi.fn();
    createLocalMeetingRealtimeAudioTransport({
      inputCommand: ["input"],
      outputCommand: ["output"],
      bargeInRmsThreshold: 10,
      bargeInPeakThreshold: 10,
      bargeInCooldownMs: 1,
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logScope: "[meeting]",
      spawn: (command) => {
        const proc = createTestBridgeProcess();
        processes.set(command, proc);
        return proc;
      },
    });
    const outputProcess = processes.get("output");
    if (!outputProcess) {
      throw new Error("Expected output process");
    }

    outputProcess.stderr.write("before exit ");
    outputProcess.emit("exit", 0, null);
    expect(debug).toHaveBeenCalledWith("[meeting] audio output: before exit");
  });
});
