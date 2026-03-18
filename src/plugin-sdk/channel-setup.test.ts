import { describe, expect, it } from "vitest";
import { createOptionalChannelSetupSurface } from "./channel-setup.js";

describe("createOptionalChannelSetupSurface", () => {
  it("returns a matched adapter and wizard for optional plugins", async () => {
    const setup = createOptionalChannelSetupSurface({
      channel: "example",
      label: "Example",
      npmSpec: "@openclaw/example",
      docsPath: "/channels/example",
    });

    expect(setup.setupAdapter.resolveAccountId?.({ cfg: {} })).toBe("default");
    expect(
      setup.setupAdapter.validateInput?.({
        cfg: {},
        accountId: "default",
        input: {},
      }),
    ).toContain("@openclaw/example");
    expect(setup.setupWizard.channel).toBe("example");
    expect(setup.setupWizard.status.unconfiguredHint).toContain("/channels/example");
    await expect(
      setup.setupWizard.finalize?.({
        cfg: {},
        accountId: "default",
        credentialValues: {},
        runtime: {
          log: () => {},
          error: () => {},
          exit: async () => {},
        },
        prompter: {} as never,
        forceAllowFrom: false,
      }),
    ).rejects.toThrow("@openclaw/example");
  });
});
