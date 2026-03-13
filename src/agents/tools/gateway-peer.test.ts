import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock loadConfig to control gateway.peers
const mockConfig = { gateway: { peers: {} } };
vi.mock("../../config/config.js", () => ({
  loadConfig: () => mockConfig,
}));

// Mock secret resolution — just pass through string values
vi.mock("../../secrets/resolve-secret-input-string.js", () => ({
  resolveSecretInputString: async (params: { value: unknown }) => {
    if (typeof params.value === "string") {
      return params.value;
    }
    return undefined;
  },
}));

import { resolveGatewayPeerOptions } from "./gateway-peer.js";

describe("resolveGatewayPeerOptions", () => {
  beforeEach(() => {
    mockConfig.gateway = {
      peers: {
        imac: { url: "wss://imac.local:18789", token: "imac-token-123" },
        studio: { url: "wss://studio.local:18789" },
      },
    };
  });

  it("returns undefined when no gateway params are provided", async () => {
    const result = await resolveGatewayPeerOptions({ message: "hello" });
    expect(result).toBeUndefined();
  });

  it("resolves named peer with url and token", async () => {
    const result = await resolveGatewayPeerOptions({ gateway: "imac" });
    expect(result).toEqual({
      gatewayUrl: "wss://imac.local:18789",
      gatewayToken: "imac-token-123",
    });
  });

  it("resolves named peer without token", async () => {
    const result = await resolveGatewayPeerOptions({ gateway: "studio" });
    expect(result).toEqual({
      gatewayUrl: "wss://studio.local:18789",
      gatewayToken: undefined,
    });
  });

  it("throws when peer name not found", async () => {
    await expect(resolveGatewayPeerOptions({ gateway: "nonexistent" })).rejects.toThrow(
      /nonexistent.*not found/,
    );
  });

  it("throws when no peers configured at all", async () => {
    mockConfig.gateway = {} as typeof mockConfig.gateway;
    await expect(resolveGatewayPeerOptions({ gateway: "imac" })).rejects.toThrow(
      /No gateway\.peers configured/,
    );
  });

  it("error message includes available peer names", async () => {
    await expect(resolveGatewayPeerOptions({ gateway: "bad" })).rejects.toThrow(
      /imac.*studio|studio.*imac/,
    );
  });

  it("explicit gatewayUrl takes effect without peer lookup", async () => {
    const result = await resolveGatewayPeerOptions({
      gatewayUrl: "wss://custom:9999",
      gatewayToken: "tok",
    });
    expect(result).toEqual({
      gatewayUrl: "wss://custom:9999",
      gatewayToken: "tok",
    });
  });

  it("gateway param takes precedence over gatewayUrl", async () => {
    const result = await resolveGatewayPeerOptions({
      gateway: "imac",
      gatewayUrl: "wss://should-be-ignored:1234",
    });
    expect(result?.gatewayUrl).toBe("wss://imac.local:18789");
  });

  it("explicit gatewayToken overrides peer token", async () => {
    const result = await resolveGatewayPeerOptions({
      gateway: "imac",
      gatewayToken: "override-token",
    });
    expect(result?.gatewayToken).toBe("override-token");
  });
});
