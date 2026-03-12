import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";

// Mock the dependencies
vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn(),
}));

vi.mock("./http-common.js", () => ({
  sendGatewayAuthFailure: vi.fn(),
}));

vi.mock("./http-utils.js", () => ({
  getBearerToken: vi.fn(),
}));

import { authorizeHttpGatewayConnect } from "./auth.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

describe("authorizeGatewayBearerRequestOrReply", () => {
  const mockReq = {} as IncomingMessage;
  const mockRes = {} as ServerResponse;
  const mockAuth = {} as ResolvedGatewayAuth;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return true for successful authorization", async () => {
    vi.mocked(getBearerToken).mockReturnValue("valid-token");
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      rateLimited: false,
    });

    const result = await authorizeGatewayBearerRequestOrReply({
      req: mockReq,
      res: mockRes,
      auth: mockAuth,
    });

    expect(result).toBe(true);
    expect(sendGatewayAuthFailure).not.toHaveBeenCalled();
  });

  it("should return false for failed authorization", async () => {
    vi.mocked(getBearerToken).mockReturnValue("invalid-token");
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: false,
      rateLimited: false,
      retryAfterMs: 0,
    });

    const result = await authorizeGatewayBearerRequestOrReply({
      req: mockReq,
      res: mockRes,
      auth: mockAuth,
    });

    expect(result).toBe(false);
    expect(sendGatewayAuthFailure).toHaveBeenCalledWith(mockRes, {
      ok: false,
      rateLimited: false,
      retryAfterMs: 0,
    });
  });

  it("should handle rate limited response", async () => {
    vi.mocked(getBearerToken).mockReturnValue("token");
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: false,
      rateLimited: true,
      retryAfterMs: 60000,
    });

    const result = await authorizeGatewayBearerRequestOrReply({
      req: mockReq,
      res: mockRes,
      auth: mockAuth,
    });

    expect(result).toBe(false);
    expect(sendGatewayAuthFailure).toHaveBeenCalledWith(mockRes, {
      ok: false,
      rateLimited: true,
      retryAfterMs: 60000,
    });
  });

  it("should pass token to authorization", async () => {
    vi.mocked(getBearerToken).mockReturnValue("bearer-token");
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      rateLimited: false,
    });

    await authorizeGatewayBearerRequestOrReply({
      req: mockReq,
      res: mockRes,
      auth: mockAuth,
    });

    expect(authorizeHttpGatewayConnect).toHaveBeenCalledWith({
      auth: mockAuth,
      connectAuth: { token: "bearer-token", password: "bearer-token" },
      req: mockReq,
      trustedProxies: undefined,
      allowRealIpFallback: undefined,
      rateLimiter: undefined,
    });
  });

  it("should handle null token", async () => {
    vi.mocked(getBearerToken).mockReturnValue(null);
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: false,
      rateLimited: false,
      retryAfterMs: 0,
    });

    await authorizeGatewayBearerRequestOrReply({
      req: mockReq,
      res: mockRes,
      auth: mockAuth,
    });

    expect(authorizeHttpGatewayConnect).toHaveBeenCalledWith({
      auth: mockAuth,
      connectAuth: null,
      req: mockReq,
      trustedProxies: undefined,
      allowRealIpFallback: undefined,
      rateLimiter: undefined,
    });
  });

  it("should pass trusted proxies option", async () => {
    vi.mocked(getBearerToken).mockReturnValue("token");
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      rateLimited: false,
    });

    const trustedProxies = ["192.168.1.0/24"];
    await authorizeGatewayBearerRequestOrReply({
      req: mockReq,
      res: mockRes,
      auth: mockAuth,
      trustedProxies,
    });

    expect(authorizeHttpGatewayConnect).toHaveBeenCalledWith(
      expect.objectContaining({ trustedProxies })
    );
  });

  it("should pass allowRealIpFallback option", async () => {
    vi.mocked(getBearerToken).mockReturnValue("token");
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      rateLimited: false,
    });

    await authorizeGatewayBearerRequestOrReply({
      req: mockReq,
      res: mockRes,
      auth: mockAuth,
      allowRealIpFallback: true,
    });

    expect(authorizeHttpGatewayConnect).toHaveBeenCalledWith(
      expect.objectContaining({ allowRealIpFallback: true })
    );
  });

  it("should pass rate limiter option", async () => {
    vi.mocked(getBearerToken).mockReturnValue("token");
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      rateLimited: false,
    });

    const mockRateLimiter = {} as AuthRateLimiter;
    await authorizeGatewayBearerRequestOrReply({
      req: mockReq,
      res: mockRes,
      auth: mockAuth,
      rateLimiter: mockRateLimiter,
    });

    expect(authorizeHttpGatewayConnect).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimiter: mockRateLimiter })
    );
  });
});
