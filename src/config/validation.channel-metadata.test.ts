import { describe, expect, it, vi } from "vitest";

const mockLoadPluginManifestRegistry = vi.hoisted(() => vi.fn());

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => mockLoadPluginManifestRegistry(...args),
}));

function setupTelegramSchemaWithDefault() {
  mockLoadPluginManifestRegistry.mockReturnValue({
    diagnostics: [],
    plugins: [
      {
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
        channelCatalogMeta: {
          id: "telegram",
          label: "Telegram",
          blurb: "Telegram channel",
        },
        channelConfigs: {
          telegram: {
            schema: {
              type: "object",
              properties: {
                dmPolicy: {
                  type: "string",
                  enum: ["pairing", "allowlist"],
                  default: "pairing",
                },
              },
              additionalProperties: false,
            },
            uiHints: {},
          },
        },
      },
    ],
  });
}

describe("validateConfigObjectWithPlugins channel metadata (applyDefaults: true)", () => {
  it("applies bundled channel defaults from plugin-owned schema metadata", async () => {
    setupTelegramSchemaWithDefault();

    const { validateConfigObjectWithPlugins } = await import("./validation.js");
    const result = validateConfigObjectWithPlugins({
      channels: {
        telegram: {},
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.channels?.telegram).toEqual(
        expect.objectContaining({ dmPolicy: "pairing" }),
      );
    }
  });
});

describe("validateConfigObjectRawWithPlugins channel metadata (applyDefaults: false)", () => {
  it("does NOT inject channel AJV defaults when applyDefaults is false", async () => {
    setupTelegramSchemaWithDefault();

    const { validateConfigObjectRawWithPlugins } = await import("./validation.js");
    const result = validateConfigObjectRawWithPlugins({
      channels: {
        telegram: {},
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // With applyDefaults: false, AJV must not inject the dmPolicy default.
      // The channel config should remain as the caller provided it.
      expect(result.config.channels?.telegram).toEqual({});
    }
  });
});
