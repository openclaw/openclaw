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
  it.each([
    {
      id: "archive",
      declared: [],
      message: "plugin must declare contracts.storageProviders for provider: archive",
    },
    {
      id: "filesystem",
      declared: ["filesystem"],
      message: 'storage provider id "filesystem" is reserved for core',
    },
  ])("rejects forbidden provider $id through the plugin API", ({ id, declared, message }) => {
    const registry = createTestPluginRegistry();
    registry
      .createApi(owner("fixture", declared), { config: {} })
      .registerStorageProvider(provider(id));
    expect(resolveStorageProvider(registry.registry, id)).toBeUndefined();
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        message,
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
});
