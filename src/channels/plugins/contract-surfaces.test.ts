import { describe, expect, it } from "vitest";
import { getBundledChannelContractSurfaceModule } from "./contract-surfaces.js";

describe("bundled channel contract surfaces", () => {
  it("resolves Telegram contract surfaces from a source checkout", () => {
    const surface = getBundledChannelContractSurfaceModule<{
      normalizeTelegramCommandName?: (value: string) => string;
    }>({
      pluginId: "telegram",
      preferredBasename: "contract-surfaces.ts",
    });

    expect(surface).not.toBeNull();
    expect(surface?.normalizeTelegramCommandName?.("/Hello-World")).toBe("hello_world");
  });

  it.each(["matrix", "mattermost", "bluebubbles", "nextcloud-talk", "tlon"])(
    "exposes legacy migration hooks for %s from a source checkout",
    (pluginId) => {
      const surface = getBundledChannelContractSurfaceModule<{
        normalizeCompatibilityConfig?: (params: { cfg: Record<string, unknown> }) => {
          config: Record<string, unknown>;
          changes: string[];
        };
        legacyConfigRules?: unknown[];
      }>({
        pluginId,
        preferredBasename: "contract-surfaces.ts",
      });

      expect(surface).not.toBeNull();
      expect(surface?.normalizeCompatibilityConfig).toBeTypeOf("function");
      expect(Array.isArray(surface?.legacyConfigRules)).toBe(true);
    },
  );
});
