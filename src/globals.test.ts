import { afterEach, describe, expect, it, vi } from "vitest";
import { isVerbose, isYes, logVerbose, setVerbose, setYes } from "./globals.js";

describe("globals", () => {
  afterEach(() => {
    setVerbose(false);
    setYes(false);
    vi.restoreAllMocks();
  });

  it("toggles verbose flag and logs when enabled", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setVerbose(false);
    logVerbose("hidden");
    expect(logSpy).not.toHaveBeenCalled();

    setVerbose(true);
    logVerbose("shown");
    expect(isVerbose()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("shown"));
  });

  it("stores yes flag", () => {
    setYes(true);
    expect(isYes()).toBe(true);
    setYes(false);
    expect(isYes()).toBe(false);
  });
});
