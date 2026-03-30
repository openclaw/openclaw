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

describe("validateConfigObjectRawWithPlugins channel metadata", () => {
  it("still injects channel AJV defaults even in raw mode — persistence safety is handled by io.ts", async () => {
    // Channel and plugin AJV validation always runs with applyDefaults: true
    // (hardcoded) to avoid breaking schemas that mark defaulted fields as
    // required (e.g., BlueBubbles enrichGroupParticipantsFromContacts).
    //
    // The actual protection against leaking these defaults to disk lives in
    // writeConfigFile (io.ts), which uses persistCandidate (the pre-validation
    // merge-patched value) instead of validated.config.
    setupTelegramSchemaWithDefault();

    const { validateConfigObjectRawWithPlugins } = await import("./validation.js");
    const result = validateConfigObjectRawWithPlugins({
      channels: {
        telegram: {},
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // AJV defaults ARE injected into validated.config even in raw mode.
      // This is intentional — see comment above.
      expect(result.config.channels?.telegram).toEqual(
        expect.objectContaining({ dmPolicy: "pairing" }),
      );
    }
  });
});
