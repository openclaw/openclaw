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

  it("inlined TELEGRAM_COMMAND_NAME_PATTERN matches the extension source", async () => {
    const { TELEGRAM_COMMAND_NAME_PATTERN } =
      await import("../../plugin-sdk/telegram-command-config.js");
    const surface = getBundledChannelContractSurfaceModule<{
      TELEGRAM_COMMAND_NAME_PATTERN?: RegExp;
    }>({
      pluginId: "telegram",
      preferredBasename: "contract-surfaces.ts",
    });

    expect(surface).not.toBeNull();
    expect(surface?.TELEGRAM_COMMAND_NAME_PATTERN).toBeDefined();
    expect(TELEGRAM_COMMAND_NAME_PATTERN.source).toBe(
      surface!.TELEGRAM_COMMAND_NAME_PATTERN!.source,
    );
    expect(TELEGRAM_COMMAND_NAME_PATTERN.flags).toBe(surface!.TELEGRAM_COMMAND_NAME_PATTERN!.flags);
  });
});
