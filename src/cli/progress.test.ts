import { Writable } from "node:stream";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { supportsOscProgress } from "../../packages/terminal-core/src/osc-progress.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { createCliProgress, withProgress } from "./progress.js";

const spinnerInstance = vi.hoisted(() => ({ start: vi.fn(), message: vi.fn(), clear: vi.fn() }));
const spinner = vi.hoisted(() => vi.fn(() => spinnerInstance));

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  spinner,
}));

function createOutput(
  isTTY: boolean,
  write: (chunk: string) => void = () => {},
  columns?: number,
): NodeJS.WriteStream {
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      write(chunk.toString());
      callback();
    },
  });
  Object.assign(output, { isTTY, columns });
  return output as NodeJS.WriteStream;
}

function withStdinIsRaw<T>(isRaw: boolean, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
  Object.defineProperty(process.stdin, "isRaw", {
    configurable: true,
    value: isRaw,
  });
  try {
    return run();
  } finally {
    if (original) {
      Object.defineProperty(process.stdin, "isRaw", original);
    } else {
      Reflect.deleteProperty(process.stdin, "isRaw");
    }
  }
}

function progress(options: Parameters<typeof createCliProgress>[0]) {
  const reporter = createCliProgress(options);
  onTestFinished(() => reporter.done());
  return reporter;
}

function captureOutput(isTTY = true) {
  const writes: string[] = [];
  return { writes, stream: createOutput(isTTY, (chunk) => writes.push(chunk)) };
}

function lineProgress(label: string, stream: NodeJS.WriteStream, delayMs?: number) {
  return progress({ label, stream, fallback: "line", delayMs });
}

describe("cli progress", () => {
  beforeEach(() => {
    for (const mock of [spinner, ...Object.values(spinnerInstance)]) {
      mock.mockClear();
    }
  });

  it.each<[number, string, string?]>([
    [36, "Checking channel status (probe)…", "Checking channel status (pro…"],
    [6, "Loading"],
  ])(
    "bounds spinner output at %i columns and removes its resize listener",
    (columns, label, expected) => {
      const stream = createOutput(true, undefined, columns);
      const reporter = progress({ label, stream });
      if (expected === undefined) {
        expect(spinnerInstance.start).not.toHaveBeenCalled();
      } else {
        expect(spinnerInstance.start).toHaveBeenCalledWith(theme.accent(expected));
      }
      reporter.done();
      expect(stream.listenerCount("resize")).toBe(0);
    },
  );

  it("does not log without a tty when fallback is none", () => {
    const write = vi.fn();
    const stream = createOutput(false, write);

    const reporter = progress({ label: "Nope", total: 2, stream, fallback: "none" });
    reporter.setPercent(50);
    reporter.done();

    expect(write).not.toHaveBeenCalled();
  });

  it("does not render progress updates after the reporter is finished", () => {
    const { writes, stream } = captureOutput(false);
    const reporter = progress({
      label: "Indexing memory...",
      total: 10,
      stream,
      fallback: "log",
    });
    reporter.done();
    reporter.setLabel("Late progress");
    reporter.setPercent(50);
    reporter.tick();

    expect(writes).toEqual(["Indexing memory... 0%\n"]);
  });

  it("does not let a finished reporter clear or unlock a newer progress line", () => {
    const secondWrite = vi.fn();
    const thirdWrite = vi.fn();
    const first = lineProgress("First", createOutput(true));
    first.done();
    const second = lineProgress("Second", createOutput(true, secondWrite));
    secondWrite.mockClear();
    first.done();
    expect(secondWrite).not.toHaveBeenCalled();
    const third = lineProgress("Third", createOutput(true, thirdWrite));
    third.done();
    expect(thirdWrite).not.toHaveBeenCalled();
    second.done();
  });

  it("routes clack spinner output through the progress stream", () => {
    const stream = createOutput(true, vi.fn());

    withStdinIsRaw(false, () => {
      const reporter = progress({ label: "Loading", stream, fallback: "spinner" });
      expect(spinner).toHaveBeenCalledWith({ output: stream });
      expect(spinnerInstance.start).toHaveBeenCalledWith(expect.stringContaining("Loading"));
      reporter.done();
    });
  });

  it("does not write terminal controls when raw TUI input suppresses the default spinner", () => {
    const { writes, stream } = captureOutput();
    withStdinIsRaw(true, () => {
      const reporter = progress({ label: "Scanning", total: 2, stream });
      reporter.setLabel("Still scanning");
      reporter.tick();
      reporter.done();
    });

    expect(writes).toStrictEqual([]);
  });

  it("unregisters a delayed tty progress line when done before start", () => {
    const { writes: firstWrites, stream: firstStream } = captureOutput();
    const secondWrite = vi.fn();
    const secondStream = createOutput(true, secondWrite);

    const delayed = lineProgress("Delayed", firstStream, 10_000);
    delayed.done();

    const next = lineProgress("Next", secondStream);
    next.done();

    expect(firstWrites).toStrictEqual([]);
    expect(secondWrite).toHaveBeenCalledWith(theme.accent("Next"));
  });

  it.each(["resolve", "reject"] as const)(
    "releases the line after work callbacks %s",
    async (outcome) => {
      const { writes: events, stream } = captureOutput();
      const oscSupported = supportsOscProgress(process.env);
      const error = new Error("work failed");
      const work = withProgress({ label: "Work", stream, fallback: "line" }, async (reporter) => {
        onTestFinished(() => reporter.done());
        await Promise.resolve();
        events.push("callback");
        reporter.setLabel("Updated");
        if (outcome === "reject") {
          throw error;
        }
        return "value";
      });
      if (outcome === "reject") {
        await expect(work).rejects.toBe(error);
      } else {
        await expect(work).resolves.toBe("value");
      }
      expect(events).toEqual([
        ...(oscSupported ? ["\x1b]9;4;3;0\x1b\\"] : []),
        "\r\x1b[2K",
        theme.accent("Work"),
        "callback",
        ...(oscSupported ? ["\x1b]9;4;3;0\x1b\\"] : []),
        "\r\x1b[2K",
        theme.accent("Updated"),
        ...(oscSupported ? ["\x1b]9;4;0;0\x1b\\"] : []),
        "\r\x1b[2K",
      ]);
      lineProgress("Next", stream);
      expect(events.at(-1)).toBe(theme.accent("Next"));
    },
  );

  it("clamps oversized delayed progress timers", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    onTestFinished(() => setTimeoutSpy.mockRestore());
    const reporter = lineProgress("Delayed", createOutput(true), Number.MAX_SAFE_INTEGER);
    reporter.done();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});
