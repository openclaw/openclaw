import { afterEach, describe, expect, it, vi } from "vitest";

const clearActiveProgressLine = vi.hoisted(() => vi.fn());

vi.mock("./progress-line.js", () => ({
  clearActiveProgressLine,
}));

import { restoreTerminalState } from "./restore.js";

describe("restoreTerminalState", () => {
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalSetRawMode = (process.stdin as { setRawMode?: (mode: boolean) => void }).setRawMode;
  const originalResume = (process.stdin as { resume?: () => void }).resume;
  const originalIsPaused = (process.stdin as { isPaused?: () => boolean }).isPaused;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      configurable: true,
    });
    (process.stdin as { setRawMode?: (mode: boolean) => void }).setRawMode = originalSetRawMode;
    (process.stdin as { resume?: () => void }).resume = originalResume;
    (process.stdin as { isPaused?: () => boolean }).isPaused = originalIsPaused;
  });

  it("does not resume paused stdin by default", () => {
    const setRawMode = vi.fn();
    const resume = vi.fn();
    const isPaused = vi.fn(() => true);

    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    (process.stdin as { setRawMode?: (mode: boolean) => void }).setRawMode = setRawMode;
    (process.stdin as { resume?: () => void }).resume = resume;
    (process.stdin as { isPaused?: () => boolean }).isPaused = isPaused;

    restoreTerminalState("test");

    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(resume).not.toHaveBeenCalled();
  });

  it("resumes paused stdin when resumeStdin is true", () => {
    const setRawMode = vi.fn();
    const resume = vi.fn();
    const isPaused = vi.fn(() => true);

    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    (process.stdin as { setRawMode?: (mode: boolean) => void }).setRawMode = setRawMode;
    (process.stdin as { resume?: () => void }).resume = resume;
    (process.stdin as { isPaused?: () => boolean }).isPaused = isPaused;

    restoreTerminalState("test", { resumeStdin: true });

    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(resume).toHaveBeenCalledOnce();
  });
});
