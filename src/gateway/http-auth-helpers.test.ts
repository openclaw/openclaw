import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn(),
  authorizeWsControlUiGatewayConnect: vi.fn(),
  isLocalDirectRequest: vi.fn(),
}));

vi.mock("./http-common.js", () => ({
  sendGatewayAuthFailure: vi.fn(),
}));

vi.mock("./http-utils.js", () => ({
  getBearerToken: vi.fn(),
}));

const { authorizeHttpGatewayConnect, authorizeWsControlUiGatewayConnect, isLocalDirectRequest } =
  await import("./auth.js");
const { sendGatewayAuthFailure } = await import("./http-common.js");
const { getBearerToken } = await import("./http-utils.js");

describe("authorizeGatewayBearerRequestOrReply", () => {
  const bearerAuth = {
    mode: "token",
    token: "secret",
    password: undefined,
    allowTailscale: true,
  } satisfies ResolvedGatewayAuth;

  const makeAuthorizeParams = () => ({
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    auth: bearerAuth,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isLocalDirectRequest).mockReturnValue(false);
  });

  it("disables tailscale header auth for HTTP bearer checks", async () => {
    vi.mocked(getBearerToken).mockReturnValue(undefined);
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: false,
      reason: "token_missing",
    });

    const ok = await authorizeGatewayBearerRequestOrReply(makeAuthorizeParams());

    expect(ok).toBe(false);
    expect(vi.mocked(authorizeHttpGatewayConnect)).toHaveBeenCalledWith(
      expect.objectContaining({
        connectAuth: null,
      }),
    );
    expect(vi.mocked(sendGatewayAuthFailure)).toHaveBeenCalledTimes(1);
  });

  it("forwards bearer token and returns true on successful auth", async () => {
    vi.mocked(getBearerToken).mockReturnValue("abc");
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({ ok: true, method: "token" });

    const ok = await authorizeGatewayBearerRequestOrReply(makeAuthorizeParams());

    expect(ok).toBe(true);
    expect(vi.mocked(authorizeHttpGatewayConnect)).toHaveBeenCalledWith(
      expect.objectContaining({
        connectAuth: { token: "abc", password: "abc" },
      }),
    );
    expect(vi.mocked(sendGatewayAuthFailure)).not.toHaveBeenCalled();
  });

  it("uses the ws control-ui auth surface when requested", async () => {
    vi.mocked(getBearerToken).mockReturnValue("abc");
    vi.mocked(authorizeWsControlUiGatewayConnect).mockResolvedValue({
      ok: true,
      method: "tailscale",
      user: "peter",
    });

    const ok = await authorizeGatewayBearerRequestOrReply({
      ...makeAuthorizeParams(),
      authSurface: "ws-control-ui",
    });

    expect(ok).toBe(true);
    expect(vi.mocked(authorizeWsControlUiGatewayConnect)).toHaveBeenCalledWith(
      expect.objectContaining({
        connectAuth: { token: "abc", password: "abc" },
      }),
    );
    expect(vi.mocked(authorizeHttpGatewayConnect)).not.toHaveBeenCalled();
  });

  it("allows configured local-direct requests without shared auth", async () => {
    vi.mocked(isLocalDirectRequest).mockReturnValue(true);

    const ok = await authorizeGatewayBearerRequestOrReply({
      ...makeAuthorizeParams(),
      allowLocalDirect: true,
    });

    expect(ok).toBe(true);
    expect(vi.mocked(authorizeHttpGatewayConnect)).not.toHaveBeenCalled();
    expect(vi.mocked(authorizeWsControlUiGatewayConnect)).not.toHaveBeenCalled();
    expect(vi.mocked(sendGatewayAuthFailure)).not.toHaveBeenCalled();
  });
});
