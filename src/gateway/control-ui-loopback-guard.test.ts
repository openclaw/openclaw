import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  function createMockReq(remoteAddress: string | undefined, url = "/"): IncomingMessage {
    return {
      url,
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

  it("allows loopback requests without warning", () => {
    const guard = createControlUiLoopbackGuard(mockLog, false);
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const result = guard(createMockReq(address), createMockRes());
      expect(result.allowed).toBe(true);
    }
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("warns but allows non-loopback requests in default mode", () => {
    const guard = createControlUiLoopbackGuard(mockLog, false);
    const result = guard(createMockReq("192.168.1.100"), createMockRes());
    expect(result.allowed).toBe(true);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("192.168.1.100"));
  });

  it("rejects non-loopback requests in strict mode", () => {
    const guard = createControlUiLoopbackGuard(mockLog, true);
    const res = createMockRes();
    const endFn = res.end;
    const result = guard(createMockReq("203.0.113.50"), res);
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(endFn).toHaveBeenCalledWith(expect.stringContaining("Forbidden"));
  });

  it("rejects unknown addresses in strict mode", () => {
    const guard = createControlUiLoopbackGuard(mockLog, true);
    const result = guard(createMockReq(undefined), createMockRes());
    expect(result.allowed).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("unknown"));
  });
});
