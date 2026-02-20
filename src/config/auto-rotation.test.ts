import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  generateSecureToken,
  storeNewSecretVersion,
  updateRotationLabels,
  updateLocalConfig,
  rotateGatewayToken,
  type RotationDeps,
} from "./auto-rotation.js";

// ===========================================================================
// Token Generation
// ===========================================================================

describe("generateSecureToken", () => {
  it("generates a hex string of correct length", () => {
    const token = generateSecureToken(32);
    expect(token).toMatch(/^[a-f0-9]{64}$/); // 32 bytes = 64 hex chars
  });

  it("defaults to 32 bytes", () => {
    const token = generateSecureToken();
    expect(token).toHaveLength(64);
  });

  it("generates unique tokens", () => {
    const a = generateSecureToken();
    const b = generateSecureToken();
    expect(a).not.toBe(b);
  });

  it("rejects byte count < 16", () => {
    expect(() => generateSecureToken(8)).toThrow();
  });
});

// ===========================================================================
// Store New Secret Version
// ===========================================================================

describe("storeNewSecretVersion", () => {
  it("calls addSecretVersion with correct params", async () => {
    const mockClient = {
      addSecretVersion: vi.fn().mockResolvedValue([{ name: "projects/p/secrets/s/versions/2" }]),
    };
    const result = await storeNewSecretVersion(
      mockClient as any,
      "n30-agents",
      "openclaw-main-gateway-token",
      "newtoken123",
    );
    expect(mockClient.addSecretVersion).toHaveBeenCalledWith({
      parent: "projects/n30-agents/secrets/openclaw-main-gateway-token",
      payload: { data: Buffer.from("newtoken123", "utf-8") },
    });
    expect(result).toContain("versions/2");
  });
});

// ===========================================================================
// Update Rotation Labels
// ===========================================================================

describe("updateRotationLabels", () => {
  it("sets correct labels on the secret", async () => {
    const mockClient = {
      getSecret: vi.fn().mockResolvedValue([{ labels: { "some-existing": "label" } }]),
      updateSecret: vi.fn().mockResolvedValue([{}]),
    };
    const now = new Date("2026-02-15T14:30:00.000Z");

    await updateRotationLabels(
      mockClient as any,
      "n30-agents",
      "openclaw-main-gateway-token",
      30,
      now,
    );

    const call = mockClient.updateSecret.mock.calls[0][0];
    expect(call.secret.labels["rotation-type"]).toBe("auto");
    expect(call.secret.labels["rotation-interval-days"]).toBe("30");
    expect(call.secret.labels["last-rotated"]).toMatch(/^2026-02-15t14-30-00/);
    expect(call.secret.labels["some-existing"]).toBe("label");
    expect(call.updateMask.paths).toContain("labels");
  });
});

// ===========================================================================
// Update Local Config
// ===========================================================================

describe("updateLocalConfig", () => {
  it("replaces the gateway token in config", () => {
    const config = {
      gateway: { auth: { mode: "token", token: "oldtoken" } },
      other: "stuff",
    };
    const result = updateLocalConfig(config, "newtoken");
    expect(result.gateway.auth.token).toBe("newtoken");
    expect(result.other).toBe("stuff");
  });

  it("throws if config has no gateway.auth.token", () => {
    expect(() => updateLocalConfig({} as any, "newtoken")).toThrow();
  });
});

// ===========================================================================
// Full Rotation Flow
// ===========================================================================

describe("rotateGatewayToken", () => {
  let deps: RotationDeps;
  let writtenConfig: any;

  beforeEach(() => {
    writtenConfig = null;
    deps = {
      project: "n30-agents",
      secretName: "openclaw-main-gateway-token",
      configPath: "/tmp/test-openclaw.json",
      readConfig: vi.fn().mockResolvedValue({
        gateway: { auth: { mode: "token", token: "oldtoken123" } },
      }),
      writeConfig: vi.fn().mockImplementation(async (_path, config) => {
        writtenConfig = config;
      }),
      getClient: vi.fn().mockResolvedValue({
        addSecretVersion: vi.fn().mockResolvedValue([{ name: "projects/p/secrets/s/versions/5" }]),
        accessSecretVersion: vi.fn().mockResolvedValue([
          { payload: { data: Buffer.from("the-new-token") } },
        ]),
        getSecret: vi.fn().mockResolvedValue([{ labels: {} }]),
        updateSecret: vi.fn().mockResolvedValue([{}]),
      }),
      intervalDays: 30,
    };
  });

  it("generates token, stores in GCP, updates config, sets labels", async () => {
    const result = await rotateGatewayToken(deps);

    expect(result.success).toBe(true);
    expect(result.oldToken).toBe("oldtoken123");
    expect(result.newToken).toHaveLength(64); // 32 bytes hex
    expect(deps.writeConfig).toHaveBeenCalled();
    expect(writtenConfig.gateway.auth.token).toBe(result.newToken);
  });

  it("verifies the new token is readable from GCP before updating config", async () => {
    const client = await deps.getClient();
    const callOrder: string[] = [];
    (client.addSecretVersion as any).mockImplementation(() => {
      callOrder.push("add");
      return [{ name: "ver/1" }];
    });
    (client.accessSecretVersion as any).mockImplementation(() => {
      callOrder.push("verify");
      return [{ payload: { data: Buffer.from("x") } }];
    });
    (deps.writeConfig as any).mockImplementation(() => {
      callOrder.push("write");
    });

    await rotateGatewayToken(deps);
    expect(callOrder).toEqual(["add", "verify", "write"]);
  });

  it("does not update config if GCP verification fails", async () => {
    const client = await deps.getClient();
    (client.accessSecretVersion as any).mockRejectedValue(new Error("GCP down"));

    const result = await rotateGatewayToken(deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain("GCP");
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it("returns old token for rollback on failure", async () => {
    const client = await deps.getClient();
    (client.accessSecretVersion as any).mockRejectedValue(new Error("fail"));

    const result = await rotateGatewayToken(deps);
    expect(result.oldToken).toBe("oldtoken123");
    expect(result.success).toBe(false);
  });
});
