import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateStateInspectionReporter } from "./update-candidate-state.diagnostics.js";

const { writeSync } = vi.hoisted(() => ({ writeSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeSync,
}));

beforeEach(() => {
  writeSync.mockReset();
});

describe("update state inspection diagnostic reporter", () => {
  const progress = {
    phase: "database snapshot",
    path: "/fixture/state.sqlite",
    snapshot: {
      status: "completed" as const,
      copiedPages: 4,
      totalPages: 4,
      copiedBytes: 16384,
      elapsedMs: 1,
    },
  };

  it("ignores argument-free callbacks without consuming the legacy diagnostic budget", () => {
    const report = createUpdateStateInspectionReporter(true);
    for (let index = 0; index < 1000; index++) {
      report(undefined);
    }
    expect(writeSync).not.toHaveBeenCalled();
    report(progress);
    expect(writeSync).toHaveBeenCalledExactlyOnceWith(
      2,
      `State schema progress: ${JSON.stringify(progress)}\n`,
    );
  });

  it.each(["EAGAIN", "EWOULDBLOCK"])(
    "drops a backpressured %s diagnostic and permits later progress",
    (code) => {
      writeSync.mockImplementationOnce(() => {
        throw Object.assign(new Error("temporarily unavailable"), { code });
      });
      const report = createUpdateStateInspectionReporter();
      expect(() => report(progress)).not.toThrow();
      report(progress);
      expect(writeSync).toHaveBeenCalledTimes(2);
      expect(writeSync).toHaveBeenLastCalledWith(
        2,
        `State schema progress: ${JSON.stringify(progress)}\n`,
      );
    },
  );

  it.each(["EAGAIN", "EWOULDBLOCK"])(
    "counts only successful legacy writes after repeated %s backpressure",
    (code) => {
      writeSync.mockImplementation(() => {
        throw Object.assign(new Error("temporarily unavailable"), { code });
      });
      const report = createUpdateStateInspectionReporter(true);
      for (let index = 0; index < 1000; index++) {
        report(progress);
      }
      writeSync.mockImplementation((_fd, line) => Buffer.byteLength(line));
      report(progress);
      expect(writeSync).toHaveBeenCalledTimes(1001);
      expect(writeSync).toHaveBeenLastCalledWith(
        2,
        `State schema progress: ${JSON.stringify(progress)}\n`,
      );
    },
  );

  it("retries the legacy omission notice after backpressure without exhausting early", () => {
    const report = createUpdateStateInspectionReporter(true);
    const line = `State schema progress: ${JSON.stringify(progress)}\n`;
    const capacity = Math.floor(12_000 / Buffer.byteLength(line));
    writeSync.mockImplementation((_fd, value) => Buffer.byteLength(value));
    for (let index = 0; index < capacity; index++) {
      report(progress);
    }
    writeSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("temporarily unavailable"), { code: "EAGAIN" });
    });
    report(progress);
    report(progress);
    report(progress);
    expect(writeSync).toHaveBeenCalledTimes(capacity + 2);
    expect(writeSync).toHaveBeenLastCalledWith(
      2,
      `State schema progress: ${JSON.stringify({ phase: "schema inspection; detailed progress omitted" })}\n`,
    );
  });

  it.each(["EIO", "EBADF", "ENOSPC", "EPIPE"])("preserves non-backpressure %s failures", (code) => {
    const failure = Object.assign(new Error("write failed"), { code });
    writeSync.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => createUpdateStateInspectionReporter()(progress)).toThrow(failure);
  });
});
