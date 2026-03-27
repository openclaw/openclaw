import { describe, expect, it, vi } from "vitest";

const mockLoadPluginManifestRegistry = vi.hoisted(() => vi.fn());

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => mockLoadPluginManifestRegistry(...args),
}));

describe("validateConfigObjectRawWithPlugins channel metadata", () => {
  it("applies bundled channel defaults from plugin-owned schema metadata", async () => {
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

    const { validateConfigObjectRawWithPlugins } = await import("./validation.js");
    const result = validateConfigObjectRawWithPlugins({
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
