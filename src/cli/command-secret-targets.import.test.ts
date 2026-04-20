import { beforeEach, describe, expect, it, vi } from "vitest";

describe("command secret targets module import", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not touch the registry during module import", async () => {
    const listSecretTargetRegistryEntries = vi.fn(() => {
      throw new Error("registry touched too early");
    });

    vi.doMock("../secrets/target-registry.js", () => ({
      discoverConfigSecretTargetsByIds: vi.fn(() => []),
      listSecretTargetRegistryEntries,
    }));

    const mod = await import("./command-secret-targets.js");

    expect(listSecretTargetRegistryEntries).not.toHaveBeenCalled();
    expect(mod.getModelsCommandSecretTargetIds().has("models.providers.*.apiKey")).toBe(true);
    expect(mod.getQrRemoteCommandSecretTargetIds().has("gateway.remote.token")).toBe(true);
    expect(
      mod.getAgentRuntimeCommandSecretTargetIds().has("agents.defaults.memorySearch.remote.apiKey"),
    ).toBe(true);
    expect(listSecretTargetRegistryEntries).not.toHaveBeenCalled();
    expect(() => mod.getChannelsCommandSecretTargetIds()).toThrow("registry touched too early");
    expect(listSecretTargetRegistryEntries).toHaveBeenCalledTimes(1);
  });

  it("can resolve configured-channel status targets without the full registry", async () => {
    const listSecretTargetRegistryEntries = vi.fn(() => {
      throw new Error("registry touched too early");
    });
    const loadBundledChannelSecretContractApi = vi.fn((channelId: string) =>
      channelId === "telegram"
        ? {
            secretTargetRegistryEntries: [
              {
                id: "channels.telegram.botToken",
                targetType: "channels.telegram.botToken",
                configFile: "openclaw.json",
                pathPattern: "channels.telegram.botToken",
                secretShape: "secret_input",
                expectedResolvedValue: "string",
                includeInPlan: true,
                includeInConfigure: true,
                includeInAudit: true,
              },
            ],
          }
        : undefined,
    );

    vi.doMock("../secrets/target-registry.js", () => ({
      discoverConfigSecretTargetsByIds: vi.fn(() => []),
      listSecretTargetRegistryEntries,
    }));
    vi.doMock("../secrets/channel-contract-api.js", () => ({
      loadBundledChannelSecretContractApi,
    }));

    const mod = await import("./command-secret-targets.js");
    const targets = mod.getStatusCommandSecretTargetIds({
      channels: { telegram: { botToken: "123456:ABCDEF" } },
    });

    expect(targets.has("channels.telegram.botToken")).toBe(true);
    expect(targets.has("agents.defaults.memorySearch.remote.apiKey")).toBe(true);
    expect(loadBundledChannelSecretContractApi).toHaveBeenCalledWith("telegram");
    expect(listSecretTargetRegistryEntries).not.toHaveBeenCalled();
  });
});
