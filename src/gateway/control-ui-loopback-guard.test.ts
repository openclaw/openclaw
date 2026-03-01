import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mock before imports
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: mockWarn,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createSubsystemLogger } from "../logging/subsystem.js";
import { createControlUiLoopbackGuard } from "./control-ui-loopback-guard.js";

describe("createControlUiLoopbackGuard", () => {
  const mockLog = createSubsystemLogger("test");

  beforeEach(() => {
    mockWarn.mockClear();
  });

  function createMockReq(remoteAddress: string | undefined): IncomingMessage {
    return {
      socket: { remoteAddress },
    } as unknown as IncomingMessage;
  }

  function createMockRes() {
    const endMock = vi.fn();
    const setHeaderMock = vi.fn();
    const res = {
      statusCode: 200,
      setHeader: setHeaderMock,
      end: endMock,
    };
    return res as unknown as ServerResponse & { end: typeof endMock };
  }

  describe("default mode (warn only)", () => {
    it("allows requests from 127.0.0.1 without warning", () => {
      const guard = createControlUiLoopbackGuard(mockLog, false);
      const req = createMockReq("127.0.0.1");
      const res = createMockRes();

      const result = guard(req, res);

      expect(result.allowed).toBe(true);
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it("allows requests from ::1 without warning", () => {
      const guard = createControlUiLoopbackGuard(mockLog, false);
      const req = createMockReq("::1");
      const res = createMockRes();

      const result = guard(req, res);

      expect(result.allowed).toBe(true);
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it("allows requests from ::ffff:127.0.0.1 without warning", () => {
      const guard = createControlUiLoopbackGuard(mockLog, false);
      const req = createMockReq("::ffff:127.0.0.1");
      const res = createMockRes();

      const result = guard(req, res);

      expect(result.allowed).toBe(true);
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it("warns but allows requests from external IPs", () => {
      const guard = createControlUiLoopbackGuard(mockLog, false);
      const req = createMockReq("192.168.1.100");
      const res = createMockRes();

      const result = guard(req, res);

      expect(result.allowed).toBe(true);
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("192.168.1.100"));
    });

    it("warns but allows requests from private network IPs", () => {
      const guard = createControlUiLoopbackGuard(mockLog, false);
      const req = createMockReq("10.0.0.1");
      const res = createMockRes();

      const result = guard(req, res);

      expect(result.allowed).toBe(true);
      expect(mockWarn).toHaveBeenCalled();
    });

    it("handles undefined remote address with warning but allows", () => {
      const guard = createControlUiLoopbackGuard(mockLog, false);
      const req = createMockReq(undefined);
      const res = createMockRes();

      const result = guard(req, res);

      expect(result.allowed).toBe(true);
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("unknown"));
    });
  });

  describe("strict mode", () => {
    it("allows requests from 127.0.0.1", () => {
      const guard = createControlUiLoopbackGuard(mockLog, true);
      const req = createMockReq("127.0.0.1");
      const res = createMockRes();

      const result = guard(req, res);

      expect(result.allowed).toBe(true);
    });

    it("rejects requests from external IPs with 403", () => {
      const guard = createControlUiLoopbackGuard(mockLog, true);
      const req = createMockReq("203.0.113.50");
      const res = createMockRes();
      const endFn = res.end;

      const result = guard(req, res);

      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(res.statusCode).toBe(403);
      expect(endFn).toHaveBeenCalledWith(expect.stringContaining("Forbidden"));
    });

    it("rejects requests from private network IPs with 403", () => {
      const guard = createControlUiLoopbackGuard(mockLog, true);
      const req = createMockReq("192.168.1.1");
      const res = createMockRes();

      const result = guard(req, res);

      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(403);
    });

    it("rejects requests with undefined remote address in strict mode", () => {
      const guard = createControlUiLoopbackGuard(mockLog, true);
      const req = createMockReq(undefined);
      const res = createMockRes();

      const result = guard(req, res);

      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("unknown"));
    });
  });
});

import { isControlUiRequest } from "./control-ui.js";

describe("isControlUiRequest", () => {
  function createReq(url: string): IncomingMessage {
    return { url } as IncomingMessage;
  }

  it("identifies avatar requests", () => {
    // Default base path
    expect(isControlUiRequest(createReq("/control-ui-avatars/agent-123.png"))).toBe(true);
    // Custom base path (normalized handles leading slash)
    expect(
      isControlUiRequest(createReq("/my-base/control-ui-avatars/agent-123.png"), "/my-base"),
    ).toBe(true);
  });

  it("identifies UI requests with base path", () => {
    const basePath = "/admin";

    // Exact match (redirect)
    expect(isControlUiRequest(createReq("/admin"), basePath)).toBe(true);

    // Sub-path
    expect(isControlUiRequest(createReq("/admin/settings"), basePath)).toBe(true);
    expect(isControlUiRequest(createReq("/admin/assets/main.js"), basePath)).toBe(true);

    // Non-matching paths
    expect(isControlUiRequest(createReq("/api/hooks"), basePath)).toBe(false);
    expect(isControlUiRequest(createReq("/"), basePath)).toBe(false);
    expect(isControlUiRequest(createReq("/admintypo"), basePath)).toBe(false);
  });

  it("identifies UI requests when base path is root (default)", () => {
    // If no base path is provided, it assumes root.
    // In our implementation, we want to be conservative or inclusive depending on policy.
    // The implementation of isControlUiRequest returns true for everything if base is root,
    // which effectively puts the guard on everything.
    // However, in server-http.ts, other handlers (Slack, OpenAI, etc) run BEFORE the control UI handler.
    // But the guard logic we added runs BEFORE those specific handlers?
    // Wait, let's re-verify server-http.ts order in a separate step if needed.
    // For now, testing the function behavior:
    expect(isControlUiRequest(createReq("/any-path"))).toBe(true);
  });
});
