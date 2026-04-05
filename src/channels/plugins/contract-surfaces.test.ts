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
});
