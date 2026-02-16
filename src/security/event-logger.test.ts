import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SecurityEvent } from "./events.js";

// Reset module registry so we get fresh imports not tainted by setup.ts
vi.resetModules();

const mockInfo = vi.fn();
const mockWarn = vi.fn();
const mockError = vi.fn();

vi.mock("./audit-log.js", () => ({
  appendAuditEntry: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    subsystem: "security",
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    isEnabled: () => true,
    child: vi.fn(),
  }),
}));

const { emitSecurityEvent } = await import("./event-logger.js");

describe("emitSecurityEvent", () => {
  beforeEach(() => {
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  it("routes info severity to info()", () => {
    const event: SecurityEvent = {
      eventType: "auth.success",
      timestamp: new Date().toISOString(),
      severity: "info",
      action: "allowed",
      detail: "token",
    };
    emitSecurityEvent(event);
    expect(mockInfo).toHaveBeenCalledOnce();
    expect(mockInfo).toHaveBeenCalledWith(
      "[auth.success] allowed: token",
      expect.objectContaining({ action: "allowed" }),
    );
  });

  it("routes warn severity to warn()", () => {
    const event: SecurityEvent = {
      eventType: "auth.failure",
      timestamp: new Date().toISOString(),
      severity: "warn",
      action: "blocked",
      detail: "token_mismatch",
    };
    emitSecurityEvent(event);
    expect(mockWarn).toHaveBeenCalledOnce();
    expect(mockWarn).toHaveBeenCalledWith(
      "[auth.failure] blocked: token_mismatch",
      expect.objectContaining({ action: "blocked" }),
    );
  });

  it("routes critical severity to error()", () => {
    const event: SecurityEvent = {
      eventType: "policy.violation",
      timestamp: new Date().toISOString(),
      severity: "critical",
      action: "blocked",
      detail: "unauthorized access",
    };
    emitSecurityEvent(event);
    expect(mockError).toHaveBeenCalledOnce();
    expect(mockError).toHaveBeenCalledWith(
      "[policy.violation] blocked: unauthorized access",
      expect.objectContaining({ action: "blocked" }),
    );
  });

  it("formats message without detail when detail is omitted", () => {
    const event: SecurityEvent = {
      eventType: "tool.call",
      timestamp: new Date().toISOString(),
      severity: "info",
      action: "allowed",
    };
    emitSecurityEvent(event);
    expect(mockInfo).toHaveBeenCalledWith(
      "[tool.call] allowed",
      expect.objectContaining({ action: "allowed" }),
    );
  });

  it("works with minimal required fields", () => {
    const event: SecurityEvent = {
      eventType: "auth.attempt",
      timestamp: "2026-01-01T00:00:00.000Z",
      severity: "info",
      action: "logged",
    };
    expect(() => emitSecurityEvent(event)).not.toThrow();
    expect(mockInfo).toHaveBeenCalledOnce();
  });

  it("works with all optional fields", () => {
    const event: SecurityEvent = {
      eventType: "injection.detected",
      timestamp: new Date().toISOString(),
      severity: "warn",
      action: "logged",
      detail: "3 suspicious pattern(s) detected",
      sessionKey: "hook:gmail:abc123",
      channel: "telegram",
      meta: { patterns: ["pattern1", "pattern2", "pattern3"] },
    };
    expect(() => emitSecurityEvent(event)).not.toThrow();
    expect(mockWarn).toHaveBeenCalledOnce();
    expect(mockWarn).toHaveBeenCalledWith(
      "[injection.detected] logged: 3 suspicious pattern(s) detected",
      expect.objectContaining({
        sessionKey: "hook:gmail:abc123",
        channel: "telegram",
        meta: { patterns: ["pattern1", "pattern2", "pattern3"] },
      }),
    );
  });

  it("does not throw for any severity level", () => {
    const base = {
      eventType: "auth.success" as const,
      timestamp: new Date().toISOString(),
      action: "test",
    };
    expect(() => emitSecurityEvent({ ...base, severity: "info" })).not.toThrow();
    expect(() => emitSecurityEvent({ ...base, severity: "warn" })).not.toThrow();
    expect(() => emitSecurityEvent({ ...base, severity: "critical" })).not.toThrow();
  });
});
