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
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(debug).toHaveBeenNthCalledWith(
        callsBeforeLine + 2,
        `[meeting] ${label}: ${unterminatedDiagnostic}`,
      );
    }

    expect(debug).toHaveBeenCalledTimes(cases.length * 2);
  });
});
