import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  authorizeGatewayBearerRequestOrReply,
  resolveGatewayRequestedOperatorScopes,
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

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

vi.mock("./token-expiry-state.js", () => ({
  consumeGatewayTokenExpiryWarning: vi.fn(),
}));

const { authorizeHttpGatewayConnect } = await import("./auth.js");
const { sendGatewayAuthFailure } = await import("./http-common.js");
const { getBearerToken, getHeader } = await import("./http-utils.js");
const { logWarn } = await import("../logger.js");
const { consumeGatewayTokenExpiryWarning } = await import("./token-expiry-state.js");

describe("authorizeGatewayBearerRequestOrReply", () => {
  const bearerAuth = {
    mode: "token",
    token: "secret",
    password: undefined,
    allowTailscale: true,
    tokenExpiryHours: 24,
  } satisfies ResolvedGatewayAuth;

  const makeAuthorizeParams = () => ({
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    auth: bearerAuth,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(consumeGatewayTokenExpiryWarning).mockReturnValue(false);
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

  it("logs a non-blocking expiry warning when consume allows (once-per-process gate)", async () => {
    vi.mocked(getBearerToken).mockReturnValue("abc");
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({ ok: true, method: "token" });
    vi.mocked(consumeGatewayTokenExpiryWarning).mockReturnValue(true);

    const ok = await authorizeGatewayBearerRequestOrReply(makeAuthorizeParams());

    expect(ok).toBe(true);
    expect(vi.mocked(logWarn)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(logWarn).mock.calls[0]?.[0] ?? "")).toContain("openclaw auth rotate");
  });

  it("does not log expiry warning when consume declines", async () => {
    vi.mocked(getBearerToken).mockReturnValue("abc");
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({ ok: true, method: "token" });
    vi.mocked(consumeGatewayTokenExpiryWarning).mockReturnValue(false);

    const ok = await authorizeGatewayBearerRequestOrReply(makeAuthorizeParams());

    expect(ok).toBe(true);
    expect(vi.mocked(logWarn)).not.toHaveBeenCalled();
  });
});

describe("resolveGatewayRequestedOperatorScopes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns CLI_DEFAULT_OPERATOR_SCOPES when header is absent", () => {
    vi.mocked(getHeader).mockReturnValue(undefined);
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual(CLI_DEFAULT_OPERATOR_SCOPES);
    // Returned array must be a copy, not the original constant.
    expect(scopes).not.toBe(CLI_DEFAULT_OPERATOR_SCOPES);
  });

  it("returns empty array when header is present but empty", () => {
    vi.mocked(getHeader).mockReturnValue("");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual([]);
  });

  it("returns empty array when header is present but only whitespace", () => {
    vi.mocked(getHeader).mockReturnValue("   ");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual([]);
  });

  it("parses comma-separated scopes from header", () => {
    vi.mocked(getHeader).mockReturnValue("operator.write,operator.read");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual(["operator.write", "operator.read"]);
  });

  it("trims whitespace around individual scopes", () => {
    vi.mocked(getHeader).mockReturnValue("  operator.write , operator.read  ");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual(["operator.write", "operator.read"]);
  });

  it("filters out empty segments from trailing commas", () => {
    vi.mocked(getHeader).mockReturnValue("operator.write,,operator.read,");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual(["operator.write", "operator.read"]);
  });

  it("returns single scope when only one is declared", () => {
    vi.mocked(getHeader).mockReturnValue("operator.approvals");
    const req = {} as IncomingMessage;
    const scopes = resolveGatewayRequestedOperatorScopes(req);
    expect(scopes).toEqual(["operator.approvals"]);
  });
});
