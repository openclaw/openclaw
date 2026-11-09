import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureDeviceToken = vi.hoisted(() => vi.fn());

vi.mock("../../../infra/device-pairing-tokens.js", () => ({
  ensureDeviceToken,
}));

import { issueGatewayConnectDeviceTokens } from "./connect-device-tokens.js";
import type { AuthenticatedGatewayConnect } from "./message-handler-types.js";

const GENERATION = "gen-live";

function connectState(overrides: Partial<AuthenticatedGatewayConnect> = {}) {
  return {
    role: "operator",
    device: { id: "device-1" },
    isBrowserOperatorUi: true,
    isWebchat: false,
    trustedProxyAuthOk: false,
    sessionUsesSharedGatewayAuth: false,
    sessionSharedGatewaySessionGeneration: undefined,
    deviceTokenSharedGatewaySessionGeneration: undefined,
    handoffBootstrapProfile: null,
    authResult: {},
    ...overrides,
  } as unknown as AuthenticatedGatewayConnect;
}

async function issue(state: AuthenticatedGatewayConnect, requiredGeneration?: string) {
  return await issueGatewayConnectDeviceTokens({
    state,
    scopes: ["operator.read"],
    hasApprovedDeviceBaseline: true,
    isIssuanceCurrent: () => true,
    requiredSharedGatewaySessionGeneration: requiredGeneration,
  });
}

function issuedIssuer() {
  expect(ensureDeviceToken).toHaveBeenCalledTimes(1);
  return ensureDeviceToken.mock.calls[0][0].issuer;
}

describe("issueGatewayConnectDeviceTokens shared-auth issuer", () => {
  beforeEach(() => {
    ensureDeviceToken.mockReset();
    ensureDeviceToken.mockResolvedValue({
      token: "tok",
      role: "operator",
      scopes: ["operator.read"],
      createdAtMs: 1,
    });
  });

  it("binds a browser token to the live generation when the session carried no shared credential", async () => {
    // QR/mobile setup code or bare device-key pairing approved on the gateway:
    // the session is not shared-auth bound, but the gateway verifies browser
    // tokens against the live generation on reconnect.
    await issue(connectState(), GENERATION);
    expect(issuedIssuer()).toEqual({ kind: "shared-gateway-auth", generation: GENERATION });
  });

  it("keeps the session-bound generation when the session authenticated with shared auth", async () => {
    await issue(
      connectState({
        sessionUsesSharedGatewayAuth: true,
        sessionSharedGatewaySessionGeneration: "gen-session",
      }),
      GENERATION,
    );
    expect(issuedIssuer()).toEqual({ kind: "shared-gateway-auth", generation: "gen-session" });
  });

  it("leaves non-browser tokens without an issuer when the session is not shared-auth bound", async () => {
    await issue(
      connectState({ role: "node", isBrowserOperatorUi: false, isWebchat: false }),
      GENERATION,
    );
    expect(issuedIssuer()).toBeUndefined();
  });

  it("mints no issuer when the gateway runs without shared auth", async () => {
    await issue(connectState(), undefined);
    expect(issuedIssuer()).toBeUndefined();
  });
});
