import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessSupervisor } from "./supervisor.js";

describe("process supervisor byte activity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves successful exit when stdout EOF is observed after its byte deadline", async () => {
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const supervisor = createProcessSupervisor();
    const afterLastByte = () => nowSpy.mockReturnValue(12_000);
    const run = await supervisor.spawn({
      mode: "child",
      argv: [process.execPath, "-e", "process.stdout.write(Buffer.from([0xe2]))"],
      stdinMode: "pipe-closed",
      noOutputTimeoutMs: 1_000,
      // Delay observation of EOF without accepting a process timeout.
      onStdoutRaw: afterLastByte,
    });
    try {
      const result = await run.wait();
      expect(result).toMatchObject({ reason: "exit", exitCode: 0, noOutputTimedOut: false });
      expect(result.stdout).not.toBe("");
    } finally {
      run.cancel();
      await supervisor.shutdown();
    }
  });

  it("keeps a child alive while stderr streams an incomplete UTF-8 character", async () => {
    const supervisor = createProcessSupervisor();
    const ready = createDeferred();
    const bytes = [0xf0, 0x9f, 0x99, 0x82];
    let onByte: (chunk: Buffer) => void = () => {};
    const script = `
      const bytes = ${JSON.stringify(bytes)};
      let index = 0;
      process.stdin.on("data", () => {
        process.stderr.write(Buffer.from([bytes[index++]]));
        if (index === bytes.length) process.stdin.destroy();
      });
      process.stdout.write("ready\\n");
    `;
    let nowMs = 10_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let run: Awaited<ReturnType<typeof supervisor.spawn>> | undefined;
    try {
      run = await supervisor.spawn({
        mode: "child",
        argv: [process.execPath, "-e", script],
        stdinMode: "pipe-open",
        noOutputTimeoutMs: 1_500,
        onStdout: (chunk) => {
          if (chunk.includes("ready")) {
            ready.resolve();
          }
        },
        onStderrRaw: (chunk) => onByte(chunk),
      });
      await Promise.race([
        ready.promise,
        run.wait().then(() => {
          throw new Error("child exited before readiness");
        }),
      ]);
      for (const byte of bytes) {
        const received = createDeferred<Buffer>();
        onByte = received.resolve;
        // Keep native I/O real, advancing both deadline clocks between observed bytes.
        nowMs += 500;
        await vi.advanceTimersByTimeAsync(500);
        run.stdin!.write("next");
        const observed = await Promise.race([
          received.promise,
          run.wait().then((result) => {
            throw new Error(`child exited before its next byte: ${result.reason}`);
          }),
        ]);
        expect(observed).toEqual(Buffer.from([byte]));
      }
      const result = await run.wait();
      expect(result).toMatchObject({ reason: "exit", exitCode: 0, noOutputTimedOut: false });
      expect(result.stderr).toBe("🙂");
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
      run?.cancel();
      await supervisor.shutdown();
    }
  });
});
