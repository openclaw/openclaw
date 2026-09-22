import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessSupervisor } from "./supervisor.js";

describe("process supervisor byte activity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["stdout", "stderr"] as const)(
    "preserves an elapsed byte deadline when %s flushes a partial character at EOF",
    async (stream) => {
      const nowSpy = vi.spyOn(performance, "now").mockReturnValue(10_000);
      const supervisor = createProcessSupervisor();
      const afterLastByte = () => nowSpy.mockReturnValue(12_000);
      const run = await supervisor.spawn({
        mode: "child",
        argv: [process.execPath, "-e", `process.${stream}.write(Buffer.from([0xe2]))`],
        stdinMode: "pipe-closed",
        noOutputTimeoutMs: 1_000,
        // Withhold the timer callback while real child pipes close after the deadline.
        onStdoutRaw: stream === "stdout" ? afterLastByte : undefined,
        onStderrRaw: stream === "stderr" ? afterLastByte : undefined,
      });
      try {
        const result = await run.wait();
        expect(result).toMatchObject({ reason: "no-output-timeout", noOutputTimedOut: true });
        expect(result[stream]).not.toBe("");
      } finally {
        run.cancel();
        await supervisor.shutdown();
      }
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "keeps a child alive while %s streams an incomplete UTF-8 character",
    async (stream) => {
      const supervisor = createProcessSupervisor();
      const ready = createDeferred();
      const bytes = [0xf0, 0x9f, 0x99, 0x82];
      let onByte: (chunk: Buffer) => void = () => {};
      const script = `
      const bytes = ${JSON.stringify(bytes)};
      let index = 0;
      process.stdin.on("data", () => {
        process.${stream}.write(Buffer.from([bytes[index++]]));
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
          onStdoutRaw: stream === "stdout" ? (chunk) => onByte(chunk) : undefined,
          onStderrRaw: stream === "stderr" ? (chunk) => onByte(chunk) : undefined,
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
        expect(result[stream]).toBe(stream === "stdout" ? "ready\n🙂" : "🙂");
      } finally {
        vi.useRealTimers();
        nowSpy.mockRestore();
        run?.cancel();
        await supervisor.shutdown();
      }
    },
  );
});
