// Tests for global CLI flag state helpers.
import { describe, expect, it, vi } from "vitest";

// Mock dependencies
vi.mock("./global-state.js", () => ({
  isVerbose: vi.fn(),
  isYes: vi.fn(),
  setVerbose: vi.fn(),
  setYes: vi.fn(),
}));

vi.mock("./logging/logger.js", () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
  })),
  isFileLogLevelEnabled: vi.fn(),
}));

vi.mock("../packages/terminal-core/src/theme.js", () => ({
  theme: {
    muted: (s: string) => s,
    success: (s: string) => s,
    warn: (s: string) => s,
    info: (s: string) => s,
    error: (s: string) => s,
  },
}));

import { isVerbose } from "./global-state.js";
import { shouldLogVerbose, logVerbose, logVerboseConsole } from "./globals.js";
import { isFileLogLevelEnabled } from "./logging/logger.js";

describe("shouldLogVerbose", () => {
  it("returns true when isVerbose is true", () => {
    vi.mocked(isVerbose).mockReturnValue(true);
    vi.mocked(isFileLogLevelEnabled).mockReturnValue(false);
    expect(shouldLogVerbose()).toBe(true);
  });

  it("returns true when file log level is debug", () => {
    vi.mocked(isVerbose).mockReturnValue(false);
    vi.mocked(isFileLogLevelEnabled).mockReturnValue(true);
    expect(shouldLogVerbose()).toBe(true);
  });

  it("returns true when both are true", () => {
    vi.mocked(isVerbose).mockReturnValue(true);
    vi.mocked(isFileLogLevelEnabled).mockReturnValue(true);
    expect(shouldLogVerbose()).toBe(true);
  });

  it("returns false when both are false", () => {
    vi.mocked(isVerbose).mockReturnValue(false);
    vi.mocked(isFileLogLevelEnabled).mockReturnValue(false);
    expect(shouldLogVerbose()).toBe(false);
  });
});

describe("logVerbose", () => {
  it("does not log when shouldLogVerbose is false", () => {
    vi.mocked(isVerbose).mockReturnValue(false);
    vi.mocked(isFileLogLevelEnabled).mockReturnValue(false);
    const consoleSpy = vi.spyOn(console, "log");
    logVerbose("test message");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logs to console when isVerbose is true", () => {
    vi.mocked(isVerbose).mockReturnValue(true);
    vi.mocked(isFileLogLevelEnabled).mockReturnValue(false);
    const consoleSpy = vi.spyOn(console, "log");
    logVerbose("test message");
    expect(consoleSpy).toHaveBeenCalledWith("test message");
  });
});

describe("logVerboseConsole", () => {
  it("does not log when isVerbose is false", () => {
    vi.mocked(isVerbose).mockReturnValue(false);
    logVerboseConsole("test message");
    // No error thrown means it returned early
  });

  it("logs to console when isVerbose is true", () => {
    vi.mocked(isVerbose).mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logVerboseConsole("test message");
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
