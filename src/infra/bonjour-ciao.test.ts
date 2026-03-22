import { describe, expect, it, vi } from "vitest";

const logDebugMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({
  logDebug: (...args: unknown[]) => logDebugMock(...args),
  logWarn: (...args: unknown[]) => logWarnMock(...args),
}));

const { ignoreCiaoUnhandledRejection } = await import("./bonjour-ciao.js");

describe("bonjour-ciao", () => {
  it("ignores and logs ciao announcement cancellation rejections", () => {
    expect(ignoreCiaoUnhandledRejection(new Error("Ciao announcement cancelled by shutdown"))).toBe(
      true,
    );
    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("ignoring unhandled ciao rejection"),
    );
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("ignores and logs ciao probing cancellation rejections", () => {
    logDebugMock.mockReset();
    logWarnMock.mockReset();

    expect(ignoreCiaoUnhandledRejection(new Error("CIAO PROBING CANCELLED"))).toBe(true);
    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("ignoring unhandled ciao rejection"),
    );
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("ignores lower-case string cancellation reasons too", () => {
    logDebugMock.mockReset();
    logWarnMock.mockReset();

    expect(ignoreCiaoUnhandledRejection("ciao announcement cancelled during cleanup")).toBe(true);
    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("ignoring unhandled ciao rejection"),
    );
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("suppresses ciao interface assertion rejections as non-fatal", () => {
    logDebugMock.mockReset();
    logWarnMock.mockReset();

    const error = Object.assign(
      new Error("Reached illegal state! IPV4 address change from defined to undefined!"),
      { name: "AssertionError" },
    );

    expect(ignoreCiaoUnhandledRejection(error)).toBe(true);
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("suppressing ciao interface assertion"),
    );
    expect(logDebugMock).not.toHaveBeenCalled();
  });

  it("keeps unrelated rejections visible", () => {
    logDebugMock.mockReset();
    logWarnMock.mockReset();

    expect(ignoreCiaoUnhandledRejection(new Error("boom"))).toBe(false);
    expect(logDebugMock).not.toHaveBeenCalled();
    expect(logWarnMock).not.toHaveBeenCalled();
  });
});
