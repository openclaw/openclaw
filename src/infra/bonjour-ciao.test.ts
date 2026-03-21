import { describe, expect, it, vi } from "vitest";

const logDebugMock = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({
  logDebug: (...args: unknown[]) => logDebugMock(...args),
}));

const { ignoreCiaoCancellationRejection } = await import("./bonjour-ciao.js");

describe("bonjour-ciao", () => {
  it("ignores and logs ciao announcement cancellation rejections", () => {
    expect(
      ignoreCiaoCancellationRejection(new Error("Ciao announcement cancelled by shutdown")),
    ).toBe(true);
    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("ignoring unhandled ciao rejection"),
    );
  });

  it("ignores and logs ciao probing cancellation rejections", () => {
    logDebugMock.mockReset();

    expect(ignoreCiaoCancellationRejection(new Error("CIAO PROBING CANCELLED"))).toBe(true);
    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("ignoring unhandled ciao rejection"),
    );
  });

  it("ignores lower-case string cancellation reasons too", () => {
    logDebugMock.mockReset();

    expect(ignoreCiaoCancellationRejection("ciao announcement cancelled during cleanup")).toBe(
      true,
    );
    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("ignoring unhandled ciao rejection"),
    );
  });

  it("keeps unrelated rejections visible", () => {
    logDebugMock.mockReset();

    expect(ignoreCiaoCancellationRejection(new Error("boom"))).toBe(false);
    expect(logDebugMock).not.toHaveBeenCalled();
  });
});
