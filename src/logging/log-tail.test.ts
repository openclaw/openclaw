import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging.js";

const resolvedRedaction = { mode: "tools" as const, patterns: [/custom-secret-[a-z]+/g] };

const { redactSensitiveTextMock, resolveRedactOptionsMock } = vi.hoisted(() => ({
  redactSensitiveTextMock: vi.fn((line: string, options?: unknown) =>
    options === resolvedRedaction
      ? line.replace("custom-secret-abcdefghijklmnopqrstuvwxyz", "custom…wxyz")
      : line,
  ),
  resolveRedactOptionsMock: vi.fn(() => resolvedRedaction),
}));

vi.mock("./redact.js", async () => {
  const actual = await vi.importActual<typeof import("./redact.js")>("./redact.js");
  return {
    ...actual,
    redactSensitiveText: (text: string, options?: unknown) =>
      redactSensitiveTextMock(text, options),
    resolveRedactOptions: () => resolveRedactOptionsMock(),
  };
});

describe("readConfiguredLogTail", () => {
  afterEach(() => {
    resolveRedactOptionsMock.mockClear();
    redactSensitiveTextMock.mockClear();
    resetLogger();
    setLoggerOverride(null);
  });

  it("reuses resolved redaction settings for returned lines", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-log-tail-"));
    const file = path.join(tempDir, "openclaw-2026-01-22.log");

    await fs.writeFile(file, "custom-secret-abcdefghijklmnopqrstuvwxyz\nsecond line\n");
    setLoggerOverride({ file });

    const result = await readConfiguredLogTail();

    expect(resolveRedactOptionsMock).toHaveBeenCalledTimes(1);
    expect(redactSensitiveTextMock).toHaveBeenNthCalledWith(
      1,
      "custom-secret-abcdefghijklmnopqrstuvwxyz",
      resolvedRedaction,
    );
    expect(redactSensitiveTextMock).toHaveBeenNthCalledWith(2, "second line", resolvedRedaction);
    expect(result.lines).toEqual(["custom…wxyz", "second line"]);

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
