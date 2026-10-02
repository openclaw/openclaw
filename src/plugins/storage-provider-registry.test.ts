import { describe, expect, it } from "vitest";
import type { StorageProvider } from "../storage/types.js";
import { createPluginRecord } from "./loader-records.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { resolveStorageProvider } from "./storage-provider-registry.js";

function provider(id: string): StorageProvider {
  return {
    id,
    label: "Fixture storage",
    open: async () => {
      throw new Error("not opened during registration");
    },
  };
}

function owner(id: string, storageProviders: string[] = []) {
  return createPluginRecord({
    id,
    name: id,
    source: `/tmp/${id}/index.js`,
    origin: "global",
    enabled: true,
    contracts: { storageProviders },
    configSchema: false,
  });
}

describe("storage provider registration", () => {
  it("rejects an undeclared provider through the plugin API", () => {
    const registry = createTestPluginRegistry();
    registry
      .createApi(owner("fixture"), { config: {} })
      .registerStorageProvider(provider("archive"));
    expect(resolveStorageProvider(registry.registry, "archive")).toBeUndefined();
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "plugin must declare contracts.storageProviders for provider: archive",
      }),
    );
  });

  it("resolves declared ids case-insensitively and preserves the original on duplicate registration", async () => {
    const registry = createTestPluginRegistry();
    const original = provider(" Archive ");
    registry
      .createApi(owner("first", ["archive"]), { config: {} })
      .registerStorageProvider(original);
    registry
      .createApi(owner("second", ["archive"]), { config: {} })
      .registerStorageProvider(provider("ARCHIVE"));
    const resolved = resolveStorageProvider(registry.registry, "ARCHIVE");
    expect(resolved?.id).toBe(" Archive ");
    await expect(
      resolved?.open({ locationName: "archive", settings: {}, resolveSecret: async () => "" }),
    ).rejects.toThrow("not opened during registration");
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        message: "storage provider already registered: archive (first)",
      }),
    );
  });

  it("reserves the core filesystem provider", () => {
    const registry = createTestPluginRegistry();
    registry
      .createApi(owner("fixture", ["filesystem"]), { config: {} })
      .registerStorageProvider(provider("filesystem"));
    expect(resolveStorageProvider(registry.registry, "filesystem")).toBeUndefined();
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        message: 'storage provider id "filesystem" is reserved for core',
      }),
    );
  });
});
