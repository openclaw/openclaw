import assert from "node:assert";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logWarn: mocks.logWarn,
  logDebug: mocks.logDebug,
}));

const { ignoreCiaoCancellationRejection } = await import("./bonjour-ciao.js");

describe("ignoreCiaoCancellationRejection", () => {
  it("suppresses ciao announcement cancellation", () => {
    const err = new Error("ciao announcement cancelled");
    expect(ignoreCiaoCancellationRejection(err)).toBe(true);
    expect(mocks.logDebug).toHaveBeenCalled();
  });

  it("suppresses IPv4 address change from defined to undefined assertion", () => {
    const err = new assert.AssertionError({
      message: "Reached illegal state! IPV4 address change from defined to undefined!",
    });
    expect(ignoreCiaoCancellationRejection(err)).toBe(true);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("suppressed ciao network-change assertion"),
    );
  });

  it("suppresses IPv4 address changed from undefined to defined assertion", () => {
    const err = new assert.AssertionError({
      message: "Reached illegal state! IPv4 address changed from undefined to defined!",
    });
    expect(ignoreCiaoCancellationRejection(err)).toBe(true);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("suppressed ciao network-change assertion"),
    );
  });

  it("does not suppress unrelated errors", () => {
    expect(ignoreCiaoCancellationRejection(new Error("something else"))).toBe(false);
    expect(ignoreCiaoCancellationRejection(new TypeError("boom"))).toBe(false);
    expect(ignoreCiaoCancellationRejection("random string")).toBe(false);
  });
});
