import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { ADMIN_SCOPE } from "../../method-scopes.js";
import { admitsPairedNativeMacosAdmin } from "./native-macos-admin-admission.js";

const pairedMac = {
  clientId: GATEWAY_CLIENT_IDS.MACOS_APP,
  clientMode: GATEWAY_CLIENT_MODES.UI,
  platform: "macOS 27.0.1",
  pairedClientId: GATEWAY_CLIENT_IDS.MACOS_APP,
  hasVerifiedDevice: true,
  pairingRecordAuthorizesSession: true,
  role: "operator",
  authMethod: "token",
  scopes: [ADMIN_SCOPE],
};

describe("paired macOS admin connection admission", () => {
  it.each(["token", "device-token"])("admits a verified %s connection", (authMethod) => {
    expect(admitsPairedNativeMacosAdmin({ ...pairedMac, authMethod })).toBe(true);
  });

  it("accepts a paired legacy darwin platform label", () => {
    expect(admitsPairedNativeMacosAdmin({ ...pairedMac, platform: "darwin" })).toBe(true);
  });

  it.each([
    [
      "spoofed macOS client from another paired product",
      { pairedClientId: GATEWAY_CLIENT_IDS.CLI },
    ],
    ["renamed client from an approved macOS device", { clientId: GATEWAY_CLIENT_IDS.CLI }],
    ["node mode", { clientMode: GATEWAY_CLIENT_MODES.NODE }],
    ["non-macOS platform", { platform: "linux" }],
    ["unsigned device", { hasVerifiedDevice: false }],
    ["pairing row not authorized for this session", { pairingRecordAuthorizesSession: false }],
    ["node role", { role: "node" }],
    ["missing auth method", { authMethod: undefined }],
    ["unauthenticated session", { authMethod: "none" }],
    ["read-only operator", { scopes: ["operator.read"] }],
  ] as const)("rejects %s", (_case, override) => {
    expect(admitsPairedNativeMacosAdmin({ ...pairedMac, ...override })).toBe(false);
  });
});
