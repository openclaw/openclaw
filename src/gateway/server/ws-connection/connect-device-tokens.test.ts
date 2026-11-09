import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureDeviceToken = vi.hoisted(() => vi.fn());
vi.mock("../../../infra/device-pairing-tokens.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/device-pairing-tokens.js")>()),
  ensureDeviceToken,
}));

import { issueGatewayConnectDeviceTokens } from "./connect-device-tokens.js";
import type { AuthenticatedGatewayConnect } from "./message-handler-types.js";

const LIVE = "gen-live";
const browser = {
  role: "operator",
  device: { id: "d1" },
  isBrowserOperatorUi: true,
  authResult: {},
};
const shared = { kind: "shared-gateway-auth" };

async function issuer(
  overrides: Record<string, unknown>,
  requiredSharedGatewaySessionGeneration?: string,
) {
  await issueGatewayConnectDeviceTokens({
    state: { ...browser, ...overrides } as unknown as AuthenticatedGatewayConnect,
    scopes: ["operator.read"],
    hasApprovedDeviceBaseline: true,
    isIssuanceCurrent: () => true,
    requiredSharedGatewaySessionGeneration,
  });
  return (ensureDeviceToken.mock.calls[0]?.[0] as { issuer?: unknown } | undefined)?.issuer;
}

describe("issueGatewayConnectDeviceTokens shared-auth issuer", () => {
  beforeEach(() => ensureDeviceToken.mockReset().mockResolvedValue(null));

  // QR/setup-code or device-key pairing: no shared credential on the session, yet the
  // Gateway verifies browser tokens against the live generation on reconnect.
  it.each([
    ["binds a browser token to the live generation", {}, LIVE, { ...shared, generation: LIVE }],
    [
      "keeps a shared-auth session's own generation",
      { sessionUsesSharedGatewayAuth: true, sessionSharedGatewaySessionGeneration: "g0" },
      LIVE,
      { ...shared, generation: "g0" },
    ],
    [
      "leaves node tokens without an issuer",
      { role: "node", isBrowserOperatorUi: false },
      LIVE,
      undefined,
    ],
    ["mints no issuer without shared auth", {}, undefined, undefined],
  ])("%s", async (_name, overrides, required, expected) => {
    expect(await issuer(overrides, required)).toEqual(expected);
  });
});
