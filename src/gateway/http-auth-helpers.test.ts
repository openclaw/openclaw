import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  authorizeGatewayBearerRequest,
  authorizeGatewayBearerRequestOrReply,
  resolveGatewayCompatibilityHttpOperatorScopes,
} from "./http-auth-helpers.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn(),
}));

vi.mock("./http-common.js", () => ({
  sendGatewayAuthFailure: vi.fn(),
}));

vi.mock("./http-utils.js", () => ({
  getBearerToken: vi.fn(),
  getHeader: vi.fn(),
}));

const { authorizeHttpGatewayConnect } = await import("./auth.js");
const { sendGatewayAuthFailure } = await import("./http-common.js");
const { getBearerToken, getHeader } = await import("./http-utils.js");

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
  });

  it("returns the auth result for successful bearer auth", async () => {
    vi.mocked(getBearerToken).mockReturnValue("abc");
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({ ok: true, method: "token" });

    const result = await authorizeGatewayBearerRequest(makeAuthorizeParams());

    expect(result).toEqual({ ok: true, method: "token" });
    expect(vi.mocked(sendGatewayAuthFailure)).not.toHaveBeenCalled();
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
});

describe("resolveGatewayCompatibilityHttpOperatorScopes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const req = {} as IncomingMessage;

  it("falls back to full operator scopes for headerless token auth", () => {
    vi.mocked(getHeader).mockReturnValue(undefined);

    expect(
      resolveGatewayCompatibilityHttpOperatorScopes({
        req,
        authResult: { ok: true, method: "token" },
        fallbackScopes: CLI_DEFAULT_OPERATOR_SCOPES,
      }),
    ).toEqual(CLI_DEFAULT_OPERATOR_SCOPES);
  });

  it("falls back to full operator scopes for headerless password auth", () => {
    vi.mocked(getHeader).mockReturnValue(undefined);

    expect(
      resolveGatewayCompatibilityHttpOperatorScopes({
        req,
        authResult: { ok: true, method: "password" },
        fallbackScopes: CLI_DEFAULT_OPERATOR_SCOPES,
      }),
    ).toEqual(CLI_DEFAULT_OPERATOR_SCOPES);
  });

  it("honors explicit caller scopes when the header is present", () => {
    vi.mocked(getHeader).mockReturnValue("operator.approvals, operator.read");

    expect(
      resolveGatewayCompatibilityHttpOperatorScopes({
        req,
        authResult: { ok: true, method: "token" },
      }),
    ).toEqual(["operator.approvals", "operator.read"]);
  });

  it("keeps explicitly empty scope headers empty", () => {
    vi.mocked(getHeader).mockReturnValue("   ");

    expect(
      resolveGatewayCompatibilityHttpOperatorScopes({
        req,
        authResult: { ok: true, method: "token" },
      }),
    ).toEqual([]);
  });

  it("does not grant implicit scopes for auth mode none", () => {
    vi.mocked(getHeader).mockReturnValue(undefined);

    expect(
      resolveGatewayCompatibilityHttpOperatorScopes({
        req,
        authResult: { ok: true, method: "none" },
      }),
    ).toEqual([]);
  });

  it("does not grant implicit scopes for trusted-proxy auth", () => {
    vi.mocked(getHeader).mockReturnValue(undefined);

    expect(
      resolveGatewayCompatibilityHttpOperatorScopes({
        req,
        authResult: { ok: true, method: "trusted-proxy", user: "proxy-user" },
      }),
    ).toEqual([]);
  });
});
