import { describe, expect, it, vi } from "vitest";
import { requireSessionKeyOrSkip } from "./session-keys.js";

describe("requireSessionKeyOrSkip", () => {
  it("returns the trimmed sessionKey when non-empty", () => {
    const log = { warn: vi.fn() };
    const out = requireSessionKeyOrSkip(
      { sessionKey: "session-abc", sessionId: "sid-1" },
      log,
      "test.site",
    );
    expect(out).toBe("session-abc");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("trims whitespace and returns the inner value", () => {
    const log = { warn: vi.fn() };
    const out = requireSessionKeyOrSkip(
      { sessionKey: "  session-xyz  ", sessionId: "sid-2" },
      log,
      "test.site",
    );
    expect(out).toBe("session-xyz");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns null and warns when sessionKey is missing", () => {
    const log = { warn: vi.fn() };
    const out = requireSessionKeyOrSkip({ sessionId: "sid-3" }, log, "test.missing");
    expect(out).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "[session-key:missing] site=test.missing sessionId=sid-3",
    );
  });

  it("returns null and warns when sessionKey is empty string", () => {
    const log = { warn: vi.fn() };
    const out = requireSessionKeyOrSkip({ sessionKey: "", sessionId: "sid-4" }, log, "test.empty");
    expect(out).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("returns null and warns when sessionKey is whitespace only", () => {
    const log = { warn: vi.fn() };
    const out = requireSessionKeyOrSkip(
      { sessionKey: "   ", sessionId: "sid-5" },
      log,
      "test.whitespace",
    );
    expect(out).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("falls back to '?' for sessionId when also missing", () => {
    const log = { warn: vi.fn() };
    requireSessionKeyOrSkip({}, log, "test.bare");
    expect(log.warn).toHaveBeenCalledWith("[session-key:missing] site=test.bare sessionId=?");
  });

  it("handles null sessionKey", () => {
    const log = { warn: vi.fn() };
    const out = requireSessionKeyOrSkip({ sessionKey: null, sessionId: "sid-7" }, log, "test.null");
    expect(out).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
