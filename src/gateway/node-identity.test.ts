import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import {
  nodePairingMatchesConnectDevice,
  resolveConnectNodeIdCandidates,
} from "./node-identity.js";

function makeConnect(overrides?: Partial<ConnectParams>): ConnectParams {
  return {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: GATEWAY_CLIENT_IDS.NODE_HOST,
      version: "test",
      platform: "windows",
      mode: GATEWAY_CLIENT_MODES.NODE,
      instanceId: "stable-node",
    },
    device: {
      id: "verified-device",
      publicKey: "public-key",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    },
    ...overrides,
  };
}

describe("gateway/node-identity", () => {
  it("prefers stable node instance id before the authenticated device id", () => {
    expect(resolveConnectNodeIdCandidates(makeConnect())).toEqual([
      "stable-node",
      "verified-device",
      GATEWAY_CLIENT_IDS.NODE_HOST,
    ]);
  });

  it("rejects unbound stable node pairings that only match client-supplied instance id", () => {
    expect(
      nodePairingMatchesConnectDevice({
        connect: makeConnect(),
        pairedNode: {
          nodeId: "stable-node",
          token: "token",
          caps: ["system"],
          commands: ["system.which"],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      }),
    ).toBe(false);
  });

  it("accepts stable node pairings bound to the verified device id", () => {
    expect(
      nodePairingMatchesConnectDevice({
        connect: makeConnect(),
        pairedNode: {
          nodeId: "stable-node",
          deviceId: "verified-device",
          token: "token",
          caps: ["system"],
          commands: ["system.which"],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      }),
    ).toBe(true);
  });

  it("accepts legacy records whose node id is the verified device id", () => {
    expect(
      nodePairingMatchesConnectDevice({
        connect: makeConnect(),
        pairedNode: {
          nodeId: "verified-device",
          token: "token",
          caps: ["system"],
          commands: ["system.which"],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      }),
    ).toBe(true);
  });

  it("rejects records whose explicit device binding differs from the verified device id", () => {
    expect(
      nodePairingMatchesConnectDevice({
        connect: makeConnect(),
        pairedNode: {
          nodeId: "verified-device",
          deviceId: "other-device",
          token: "token",
          caps: ["system"],
          commands: ["system.which"],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      }),
    ).toBe(false);
  });

  it("rejects device-bound stable records when device auth is missing", () => {
    expect(
      nodePairingMatchesConnectDevice({
        connect: makeConnect({ device: undefined }),
        pairedNode: {
          nodeId: "stable-node",
          deviceId: "verified-device",
          token: "token",
          caps: ["system"],
          commands: ["system.which"],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      }),
    ).toBe(false);
  });

  it("rejects stable records bound to a different device id", () => {
    expect(
      nodePairingMatchesConnectDevice({
        connect: makeConnect({
          device: {
            id: "rotated-device",
            publicKey: "new-public-key",
            signature: "signature",
            signedAt: 1,
            nonce: "nonce",
          },
        }),
        pairedNode: {
          nodeId: "stable-node",
          deviceId: "verified-device",
          token: "token",
          caps: ["system"],
          commands: ["system.which"],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      }),
    ).toBe(false);
  });
});
