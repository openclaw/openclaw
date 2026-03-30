import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn(),
}));

vi.mock("./http-common.js", () => ({
  sendGatewayAuthFailure: vi.fn(),
}));

const { authorizeHttpGatewayConnect } = await import("./auth.js");
const { sendGatewayAuthFailure } = await import("./http-common.js");
const { authorizeGatewayHttpRequestOrReply } = await import("./http-utils.js");

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("authorizeGatewayHttpRequestOrReply", () => {
  beforeEach(() => {
    vi.mocked(authorizeHttpGatewayConnect).mockReset();
    vi.mocked(sendGatewayAuthFailure).mockReset();
  });

  it("marks token-authenticated requests as untrusted for declared HTTP scopes", async () => {
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      method: "token",
    });

    await expect(
      authorizeGatewayHttpRequestOrReply({
        req: createReq({ authorization: "Bearer secret" }),
        res: {} as ServerResponse,
        auth: { mode: "trusted-proxy", allowTailscale: false, token: "secret" },
        trustedProxies: ["127.0.0.1"],
      }),
    ).resolves.toEqual({
      authMethod: "token",
      trustDeclaredOperatorScopes: false,
    });
  });

  it("keeps trusted-proxy requests eligible for declared HTTP scopes", async () => {
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      method: "trusted-proxy",
      user: "operator",
    });

    await expect(
      authorizeGatewayHttpRequestOrReply({
        req: createReq({ authorization: "Bearer upstream-idp-token" }),
        res: {} as ServerResponse,
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: { userHeader: "x-user" },
        },
        trustedProxies: ["127.0.0.1"],
      }),
    ).resolves.toEqual({
      authMethod: "trusted-proxy",
      trustDeclaredOperatorScopes: true,
    });
  });

  it("replies with auth failure and returns null when auth fails", async () => {
    const res = {} as ServerResponse;
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: false,
      reason: "unauthorized",
    });

    await expect(
      authorizeGatewayHttpRequestOrReply({
        req: createReq(),
        res,
        auth: { mode: "token", allowTailscale: false, token: "secret" },
      }),
    ).resolves.toBeNull();

    expect(sendGatewayAuthFailure).toHaveBeenCalledWith(res, {
      ok: false,
      reason: "unauthorized",
    });
  });
});
