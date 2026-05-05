import { describe, expect, it, vi } from "vitest";
import { logAckFailure, logInboundDrop, logTypingFailure } from "./logging.js";

describe("channel logging sanitization", () => {
  it("strips newlines from error messages to prevent log injection", () => {
    const log = vi.fn();
    logTypingFailure({
      log,
      channel: "test",
      error: "real error\nFAKE: admin logged in from 1.2.3.4",
    });
    expect(log).toHaveBeenCalledOnce();
    const msg = log.mock.calls[0][0];
    expect(msg).not.toContain("\n");
    expect(msg).toContain("real error");
    expect(msg).toContain("FAKE: admin logged in from 1.2.3.4");
  });

  it("strips carriage returns from error messages", () => {
    const log = vi.fn();
    logAckFailure({
      log,
      channel: "test",
      error: "line1\r\nline2",
    });
    const msg = log.mock.calls[0][0];
    expect(msg).not.toContain("\r");
    expect(msg).not.toContain("\n");
  });

  it("strips control characters from target parameter", () => {
    const log = vi.fn();
    logInboundDrop({
      log,
      channel: "test",
      reason: "rate-limit",
      target: "user\x00\x1fid",
    });
    const msg = log.mock.calls[0][0];
    // eslint-disable-next-line no-control-regex -- intentional: verify control chars are stripped
    expect(msg).not.toMatch(/[\u0000-\u001f]/);
    expect(msg).toContain("user");
    expect(msg).toContain("id");
  });

  it("strips control characters from reason parameter", () => {
    const log = vi.fn();
    logInboundDrop({
      log,
      channel: "test",
      reason: "bad\tinput\nhere",
    });
    const msg = log.mock.calls[0][0];
    expect(msg).not.toContain("\t");
    expect(msg).not.toContain("\n");
  });

  it("handles error objects with malicious toString()", () => {
    const log = vi.fn();
    const malicious = {
      toString() {
        return "ok\nCRITICAL: system compromised";
      },
    };
    logTypingFailure({ log, channel: "test", error: malicious });
    const msg = log.mock.calls[0][0];
    expect(msg).not.toContain("\n");
    expect(msg).toContain("ok");
    expect(msg).toContain("CRITICAL: system compromised");
  });

  it("preserves normal log messages without modification", () => {
    const log = vi.fn();
    logTypingFailure({
      log,
      channel: "telegram",
      target: "user123",
      action: "start",
      error: "timeout",
    });
    expect(log).toHaveBeenCalledWith("telegram typing action=start failed target=user123: timeout");
  });
});
