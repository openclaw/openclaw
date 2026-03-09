import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

type BackgroundAppearanceModule = {
  clearDebuggerAppearanceOverrides: (
    sendCommand: (
      debuggee: { tabId: number },
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>,
    debuggee: { tabId: number },
  ) => Promise<void>;
};

const require = createRequire(import.meta.url);
const BACKGROUND_APPEARANCE_MODULE = "../../assets/chrome-extension/background-appearance.js";

async function loadBackgroundAppearance(): Promise<BackgroundAppearanceModule> {
  try {
    return require(BACKGROUND_APPEARANCE_MODULE) as BackgroundAppearanceModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unexpected token 'export'")) {
      throw error;
    }
    return (await import(BACKGROUND_APPEARANCE_MODULE)) as BackgroundAppearanceModule;
  }
}

const { clearDebuggerAppearanceOverrides } = await loadBackgroundAppearance();

describe("chrome extension background appearance", () => {
  it("clears media and auto-dark overrides after attach", async () => {
    const sendCommand = vi.fn(async () => ({}));

    await clearDebuggerAppearanceOverrides(sendCommand, { tabId: 7 });

    expect(sendCommand).toHaveBeenNthCalledWith(1, { tabId: 7 }, "Emulation.setEmulatedMedia", {
      media: "",
      features: [],
    });
    expect(sendCommand).toHaveBeenNthCalledWith(
      2,
      { tabId: 7 },
      "Emulation.setAutoDarkModeOverride",
      {},
    );
  });

  it("keeps attach flow resilient when overrides are unsupported", async () => {
    const sendCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("Emulation.setEmulatedMedia not supported"))
      .mockRejectedValueOnce(new Error("Emulation.setAutoDarkModeOverride not supported"));

    await expect(clearDebuggerAppearanceOverrides(sendCommand, { tabId: 9 })).resolves.toBe(
      undefined,
    );
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });
});
