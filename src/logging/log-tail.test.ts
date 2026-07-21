// Log tail tests cover reading, parsing, and limiting recent log entries.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const resolvedRedaction = { mode: "tools" as const, patterns: [/custom-secret-[a-z]+/g] };
type PositionalRead = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

const { redactSensitiveLinesMock, resolveRedactOptionsMock } = vi.hoisted(() => ({
  redactSensitiveLinesMock: vi.fn((lines: string[], options?: unknown) =>
    options === resolvedRedaction
      ? lines.map((line) => line.replace("custom-secret-abcdefghijklmnopqrstuvwxyz", "custom…wxyz"))
      : lines,
  ),
  resolveRedactOptionsMock: vi.fn(() => resolvedRedaction),
}));

vi.mock("./redact.js", async () => {
  const actual = await vi.importActual<typeof import("./redact.js")>("./redact.js");
  return {
    ...actual,
    redactSensitiveLines: (lines: string[], options?: unknown) =>
      redactSensitiveLinesMock(lines, options),
    resolveRedactOptions: () => resolveRedactOptionsMock(),
  };
});

describe("readConfiguredLogTail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resolveRedactOptionsMock.mockClear();
    redactSensitiveLinesMock.mockClear();
    resetLogger();
    setLoggerOverride(null);
  });

  it("applies redaction once per request across all returned lines", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const file = path.join(tempDir, "openclaw-2026-01-22.log");

    await fs.writeFile(file, "custom-secret-abcdefghijklmnopqrstuvwxyz\nsecond line\n");
    setLoggerOverride({ file });

    const result = await readConfiguredLogTail();

    expect(resolveRedactOptionsMock).toHaveBeenCalledTimes(1);
    expect(redactSensitiveLinesMock).toHaveBeenCalledTimes(1);
    expect(redactSensitiveLinesMock).toHaveBeenCalledWith(
      ["custom-secret-abcdefghijklmnopqrstuvwxyz", "second line"],
      resolvedRedaction,
    );
    expect(result.lines).toEqual(["custom…wxyz", "second line"]);
  });

  it("fills short positional reads before splitting log lines", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const file = path.join(tempDir, "openclaw-2026-01-22.log");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle) as PositionalRead;
      const shortRead = vi.fn<PositionalRead>((buffer, offset, length, position) =>
        realRead(buffer, offset, Math.min(length, 4), position),
      );
      Object.defineProperty(handle, "read", { configurable: true, value: shortRead });
      return handle;
    });

    await fs.writeFile(file, "old line\nrecent one\nrecent two\n");
    setLoggerOverride({ file });

    const result = await readConfiguredLogTail();

    expect(result.lines).toEqual(["old line", "recent one", "recent two"]);
  });

  it("reports skipped bytes without reset when the file grew faster than --max-bytes between polls", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const file = path.join(tempDir, "openclaw-2026-01-22.log");

    await fs.writeFile(file, "first line\n");
    setLoggerOverride({ file });
    const initial = await readConfiguredLogTail();

    // The file grows by far more than maxBytes between polls (e.g. a burst of
    // log activity). The cursor is still valid — readConfiguredLogTail should
    // fast-forward and report `truncated: true` plus `skippedBytes` so callers
    // know lines were skipped and can re-anchor, but `reset` must stay false
    // because the log was not rotated.
    const burst = `${"x".repeat(40)}\n`.repeat(200);
    await fs.appendFile(file, burst);

    const result = await readConfiguredLogTail({
      cursor: initial.cursor,
      maxBytes: 500,
    });

    expect(result.truncated).toBe(true);
    expect(result.reset).toBe(false);
    expect(result.skippedBytes).toBeGreaterThan(0);
    expect(result.lines.length).toBeGreaterThan(0);
  });

  it("reports reset when the file shrank below the previous cursor (rotation)", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const file = path.join(tempDir, "openclaw-2026-01-22.log");

    await fs.writeFile(file, "old line one\nold line two\nold line three\n");
    setLoggerOverride({ file });
    const initial = await readConfiguredLogTail();

    // Simulate rotation: replace the file with shorter content so that the
    // previous cursor is now past EOF.
    await fs.writeFile(file, "fresh\n");

    const result = await readConfiguredLogTail({ cursor: initial.cursor });

    expect(result.reset).toBe(true);
    expect(result.skippedBytes).toBe(0);
  });
});
