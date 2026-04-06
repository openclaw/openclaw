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
    expect(listSecretTargetRegistryEntries).not.toHaveBeenCalled();
    expect(() => mod.getChannelsCommandSecretTargetIds()).toThrow("registry touched too early");
    expect(listSecretTargetRegistryEntries).toHaveBeenCalledTimes(1);
  });
});
