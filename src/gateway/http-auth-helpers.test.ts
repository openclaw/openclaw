import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";

vi.mock("./auth.js", () => ({
  authorizeGatewayConnect: vi.fn(),
}));

vi.mock("./http-common.js", () => ({
  sendGatewayAuthFailure: vi.fn(),
}));

vi.mock("./http-utils.js", () => ({
  getBearerToken: vi.fn(),
}));

const { authorizeGatewayConnect } = await import("./auth.js");
const { sendGatewayAuthFailure } = await import("./http-common.js");
const { getBearerToken } = await import("./http-utils.js");

describe("authorizeGatewayBearerRequestOrReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables tailscale header auth for HTTP bearer checks", async () => {
    vi.mocked(getBearerToken).mockReturnValue(null);
    vi.mocked(authorizeGatewayConnect).mockResolvedValue({
      ok: false,
      reason: "token_missing",
    });

    const ok = await authorizeGatewayBearerRequestOrReply({
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      auth: {
        mode: "token",
        token: "secret",
        password: undefined,
        allowTailscale: true,
      } satisfies ResolvedGatewayAuth,
    });

    expect(ok).toBe(false);
    expect(vi.mocked(authorizeGatewayConnect)).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTailscaleHeaderAuth: false,
        connectAuth: null,
      }),
    );
    expect(vi.mocked(sendGatewayAuthFailure)).toHaveBeenCalledTimes(1);
  });

  it("forwards bearer token and returns true on successful auth", async () => {
    vi.mocked(getBearerToken).mockReturnValue("abc");
    vi.mocked(authorizeGatewayConnect).mockResolvedValue({ ok: true, method: "token" });

    const ok = await authorizeGatewayBearerRequestOrReply({
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      auth: {
        mode: "token",
        token: "secret",
        password: undefined,
        allowTailscale: true,
      } satisfies ResolvedGatewayAuth,
    });

    expect(ok).toBe(true);
    expect(vi.mocked(authorizeGatewayConnect)).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTailscaleHeaderAuth: false,
        connectAuth: { token: "abc", password: "abc" },
      }),
    );
    expect(vi.mocked(sendGatewayAuthFailure)).not.toHaveBeenCalled();
  });
});
