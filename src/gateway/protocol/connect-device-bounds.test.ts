import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./client-info.js";
import { validateConnectParams } from "./index.js";
import { DEVICE_PUBLIC_KEY_MAX_LENGTH, DEVICE_SIGNATURE_MAX_LENGTH } from "./schema/primitives.js";

function makeConnectParams(deviceOverrides: Partial<Record<string, unknown>>) {
  return {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: GATEWAY_CLIENT_IDS.CLI,
      version: "dev",
      platform: "linux",
      mode: GATEWAY_CLIENT_MODES.CLI,
    },
    role: "node",
    scopes: [],
    device: {
      id: "0".repeat(64),
      publicKey: "abc",
      signature: "def",
      signedAt: 0,
      nonce: "n",
      ...deviceOverrides,
    },
  };
}

describe("ConnectParams device handshake bounds", () => {
  it("accepts realistic-sized publicKey and signature inputs", () => {
    const ok = validateConnectParams(
      makeConnectParams({
        publicKey: "a".repeat(DEVICE_PUBLIC_KEY_MAX_LENGTH),
        signature: "b".repeat(DEVICE_SIGNATURE_MAX_LENGTH),
      }),
    );
    expect(ok).toBe(true);
  });

  it("rejects oversized device.publicKey at the schema layer (DoS amplification defense)", () => {
    const ok = validateConnectParams(
      makeConnectParams({
        publicKey: "a".repeat(DEVICE_PUBLIC_KEY_MAX_LENGTH + 1),
      }),
    );
    expect(ok).toBe(false);
  });

  it("rejects oversized device.signature at the schema layer", () => {
    const ok = validateConnectParams(
      makeConnectParams({
        signature: "b".repeat(DEVICE_SIGNATURE_MAX_LENGTH + 1),
      }),
    );
    expect(ok).toBe(false);
  });

  it("still accepts empty-string inputs failure mode (handled deeper in handshake)", () => {
    // minLength: 1 still applies; an empty string is rejected.
    expect(validateConnectParams(makeConnectParams({ publicKey: "" }))).toBe(false);
    expect(validateConnectParams(makeConnectParams({ signature: "" }))).toBe(false);
  });
});
