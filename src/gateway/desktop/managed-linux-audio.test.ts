import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { assertAudioCurrent, createAudioFixture } from "./audio.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(options?: Parameters<typeof createAudioFixture>[1]) {
  const f = createAudioFixture(tempDirs.make("desktop-audio-test-"), options);
  cleanups.push(() => f.owner.stop());
  return f;
}

function expectCaptureStopped(f: ReturnType<typeof fixture>) {
  expect(f.runs.map((run) => run.activity.resultSettled)).toEqual([false, true]);
}

describe("managed Linux private audio", () => {
  it("loads only a private null sink and does not record before explicit start", async () => {
    const f = fixture();
    const audio = await f.owner.ready;
    expect(audio.source).toBeDefined();
    expect(f.inputs).toHaveLength(1);
    expect(f.inputs[0]?.argv).toContain("-n");
    expect(f.inputs[0]?.env?.PULSE_RUNTIME_PATH).toBe(path.join(f.tempDir, "pulse"));
    const script = await fs.readFile(path.join(f.tempDir, "pulse", "default.pa"), "utf8");
    expect(script.match(/load-module /gu)).toHaveLength(2);
    expect(script).toContain("module-null-sink sink_name=openclaw_desktop");
    expect(script).not.toMatch(/udev|alsa|tcp|default.pa/u);
    expect(await fs.readFile(path.join(f.tempDir, "pulse", "client.conf"), "utf8")).toBe(
      "autospawn = no\n",
    );
    const capture = await audio.source!.start(new AbortController().signal);
    expect(f.inputs[1]?.argv).toEqual([
      "parec",
      "--server=" + f.env.PULSE_SERVER,
      "--device=openclaw_desktop.monitor",
      "--raw",
      "--format=s16le",
      "--rate=48000",
      "--channels=2",
      "--channel-map=front-left,front-right",
      "--latency-msec=40",
    ]);
    expect(f.inputs[1]?.captureOutput).toBe(false);
    expect(capture.stream.read()).toEqual(Buffer.from([0, 128, 255, 127]));
    await capture.stop();
    expectCaptureStopped(f);
  });

  it.each(["missing server", "missing recorder", "server timeout"])(
    "reaps unavailable audio setup: %s",
    async (failure) => {
      const missing =
        failure === "server timeout"
          ? undefined
          : failure === "missing server"
            ? "pulseaudio"
            : "parec";
      vi.useFakeTimers();
      const f = fixture(missing ? { missing } : { silentServer: true });
      if (!missing) {
        await f.serverSpawned.promise;
        await vi.advanceTimersByTimeAsync(5_001);
      }
      const audio = await f.owner.ready;
      expect(audio.source).toBeUndefined();
      expect(audio.failed).toBeUndefined();
      expect(audio.unavailableReason).toContain(
        missing ? missing + " is not installed" : "startup timed out",
      );
      expect(f.inputs).toHaveLength(missing ? 0 : 1);
      expect(f.scopeCleaned).toHaveBeenCalledOnce();
      expect(f.runs.every((run) => run.activity.resultSettled)).toBe(true);
    },
  );

  it.each([
    ["timeout", "capture startup timed out"],
    ["abort", "aborted"],
    ["authority", "viewer retired"],
    ["spawn", "parec spawn failed"],
  ] as const)(
    "joins failed capture admission without stopping the server: %s",
    async (failure, message) => {
      let current = true;
      const f = fixture({
        silentCapture: failure === "timeout",
        deferCapture: failure === "abort",
        captureFailure: failure === "spawn",
        beforeCaptureReturn:
          failure === "authority"
            ? () => {
                current = false;
              }
            : undefined,
      });
      const audio = await f.owner.ready;
      if (failure === "spawn") {
        await expect(audio.source!.start(AbortSignal.abort())).rejects.toThrow();
        expect(f.inputs).toHaveLength(1);
      }
      if (failure === "timeout") {
        vi.useFakeTimers();
      }
      const controller = new AbortController();
      const started = audio.source!.start(
        controller.signal,
        failure === "authority" ? () => assertAudioCurrent(current) : undefined,
      );
      const rejected = expect(started).rejects.toThrow(message);
      if (failure === "timeout" || failure === "abort") {
        await f.captureSpawned.promise;
        if (failure === "timeout") {
          await vi.advanceTimersByTimeAsync(5_001);
        } else {
          controller.abort();
          f.captureAdmission.resolve();
        }
      }
      await rejected;
      if (failure === "authority") {
        expect(f.captureAdmitted).toHaveBeenCalledOnce();
      }
      expectCaptureStopped(f);
    },
  );

  it("bounds unread PCM and terminates a stalled viewer", async () => {
    const f = fixture();
    const audio = await f.owner.ready;
    const capture = await audio.source!.start(new AbortController().signal);
    f.inputs[1]?.onStdoutRaw?.(Buffer.alloc(192_000));
    expect(capture.stream.destroyed).toBe(true);
    expect(capture.stream.errored?.message).toContain("not consuming");
    await capture.stop();
    expect(f.runs[1]?.activity.resultSettled).toBe(true);
  });
});
