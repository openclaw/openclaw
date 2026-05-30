import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveNodeIdentityId } from "./node-identity.js";

function makeConnectParams(overrides?: Partial<ConnectParams>): ConnectParams {
  return {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: GATEWAY_CLIENT_IDS.NODE_HOST,
      version: "1.0.0",
      platform: "darwin",
      mode: "node",
    },
    device: {
      id: "device-uuid",
      publicKey: "public-key",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    },
    caps: [],
    commands: [],
    ...overrides,
  };
}

describe("resolveNodeIdentityId", () => {
  it("prefers an already resolved runtime node identity", () => {
    expect(
      resolveNodeIdentityId({
        nodeIdentity: { nodeId: " resolved-node-id " },
        connect: makeConnectParams({
          client: {
            id: GATEWAY_CLIENT_IDS.NODE_HOST,
            version: "1.0.0",
            platform: "darwin",
            mode: "node",
            instanceId: "custom-node-id",
          },
        }),
      }),
    ).toBe("resolved-node-id");
  });

  it("prefers a non-empty trimmed instanceId", () => {
    expect(
      resolveNodeIdentityId({
        connect: makeConnectParams({
          client: {
            id: GATEWAY_CLIENT_IDS.NODE_HOST,
            version: "1.0.0",
            platform: "darwin",
            mode: "node",
            instanceId: " custom-node-id ",
          },
        }),
      }),
    ).toBe("custom-node-id");
  });

  it("ignores instanceId when the caller has not verified it in the device signature", () => {
    expect(
      resolveNodeIdentityId(
        {
          connect: makeConnectParams({
            client: {
              id: GATEWAY_CLIENT_IDS.NODE_HOST,
              version: "1.0.0",
              platform: "darwin",
              mode: "node",
              instanceId: "custom-node-id",
            },
          }),
        },
        { trustInstanceId: false },
      ),
    ).toBe("device-uuid");
  });

  it("falls back from blank instanceId to deviceId", () => {
    expect(
      resolveNodeIdentityId({
        connect: makeConnectParams({
          client: {
            id: GATEWAY_CLIENT_IDS.NODE_HOST,
            version: "1.0.0",
            platform: "darwin",
            mode: "node",
            instanceId: "   ",
          },
          device: {
            id: "device-uuid",
            publicKey: "public-key",
            signature: "signature",
            signedAt: 1,
            nonce: "nonce",
          },
        }),
      }),
    ).toBe("device-uuid");
  });

  it("falls back from missing ids to clientId", () => {
    expect(
      resolveNodeIdentityId({
        connect: {
          ...makeConnectParams({
            client: {
              id: GATEWAY_CLIENT_IDS.NODE_HOST,
              version: "1.0.0",
              platform: "darwin",
              mode: "node",
            },
          }),
          device: undefined,
          client: {
            id: GATEWAY_CLIENT_IDS.NODE_HOST,
            version: "1.0.0",
            platform: "darwin",
            mode: "node",
          },
        },
      }),
    ).toBe(GATEWAY_CLIENT_IDS.NODE_HOST);
  });
});
