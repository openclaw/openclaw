// Setup migration option tests exercise manifest discovery without runtime mocks.
import { beforeAll, describe, expect, it } from "vitest";
import { listSetupMigrationOptions } from "./setup.migration-import.js";

describe("setup migration import options", () => {
  let initialOptions: Awaited<ReturnType<typeof listSetupMigrationOptions>>;

  beforeAll(async () => {
    initialOptions = await listSetupMigrationOptions({
      baseConfig: {},
      detections: [],
    });
  });

  it("offers bundled manifest migration providers before plugin activation", () => {
    expect(initialOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "codex", label: "Codex" }),
        expect.objectContaining({ providerId: "claude", label: "Claude" }),
        expect.objectContaining({ providerId: "hermes", label: "Hermes" }),
      ]),
    );
  });

  it("offers official installable Codex when bundled plugins are unavailable", async () => {
    const previousDisableBundled = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    const previousDisablePersisted = process.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    process.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY = "1";
    try {
      const options = await listSetupMigrationOptions({
        baseConfig: {},
        detections: [],
      });

      expect(options).toEqual(
        expect.arrayContaining([expect.objectContaining({ providerId: "codex", label: "Codex" })]),
      );
    } finally {
      if (previousDisableBundled === undefined) {
        delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      } else {
        process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = previousDisableBundled;
      }
      if (previousDisablePersisted === undefined) {
        delete process.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY;
      } else {
        process.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY = previousDisablePersisted;
      }
    }
  });
});
