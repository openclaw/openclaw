import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { maybeConfigureSoulFiles } from "./onboard-channels.js";
import { createWizardPrompter } from "./test-wizard-helpers.js";

describe("maybeConfigureSoulFiles", () => {
  it("skips SOUL prompts for channels without account-scoped soulFile support", async () => {
    const note = vi.fn(async () => {});
    const confirm = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Configure custom SOUL (personality) files for channels?") {
        return true;
      }
      if (message.startsWith("Use custom SOUL file for ")) {
        throw new Error(`unexpected per-channel SOUL prompt: ${message}`);
      }
      return false;
    });
    const text = vi.fn(async ({ message }: { message: string }) => {
      throw new Error(`unexpected text prompt: ${message}`);
    });
    const prompter = createWizardPrompter({
      note,
      confirm: confirm as unknown as WizardPrompter["confirm"],
      text: text as unknown as WizardPrompter["text"],
    });

    const next = await maybeConfigureSoulFiles({
      cfg: {} as OpenClawConfig,
      selection: ["msteams"],
      prompter,
      accountIdsByChannel: new Map([["msteams", "default"]]),
    });

    expect(next).toEqual({});
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Skipped SOUL file setup for channels that do not support account-scoped soulFile config:",
      ),
      "Channel SOUL files",
    );
    expect(note).toHaveBeenCalledWith(expect.stringContaining("- msteams"), "Channel SOUL files");
    expect(text).not.toHaveBeenCalled();
  });
});
