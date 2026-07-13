import {
  createQueuedWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import type { ChannelSetupWizard } from "./setup-wizard-types.js";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "./setup-wizard.js";

describe("buildChannelSetupWizardAdapterFromSetupWizard", () => {
  it("propagates a cancelled finalize before showing completion", async () => {
    const prompts = createQueuedWizardPrompter();
    const wizard = {
      channel: "demo",
      status: {
        configuredLabel: "configured",
        unconfiguredLabel: "needs setup",
        resolveConfigured: () => false,
      },
      credentials: [],
      finalize: () => ({ cancelled: true as const }),
      completionNote: {
        title: "Done",
        lines: ["Configured"],
      },
    } satisfies ChannelSetupWizard;
    const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
      plugin: {
        id: "demo",
        meta: { label: "Demo" },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
        },
      } as unknown as Parameters<typeof buildChannelSetupWizardAdapterFromSetupWizard>[0]["plugin"],
      wizard,
    });

    await expect(
      runSetupWizardConfigure({
        configure: adapter.configure,
        prompter: prompts.prompter,
      }),
    ).resolves.toEqual({ cfg: {}, cancelled: true });
    expect(prompts.note).not.toHaveBeenCalled();
  });
});
