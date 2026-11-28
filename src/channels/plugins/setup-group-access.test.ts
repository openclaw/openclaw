// Setup group access tests cover group access setup flow decisions and outputs.
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { promptChannelAccessConfig } from "./setup-group-access.js";

function createPrompter(params: { select: string; textError?: string }) {
  const confirm = vi.fn(async () => true);
  const text = vi.fn(async () => {
    if (params.textError) {
      throw new Error(params.textError);
    }
    return "";
  });
  return createWizardPrompter({ confirm, text }, { defaultSelect: params.select });
}

describe("promptChannelAccessConfig policy-only entries", () => {
  it("skips the allowlist text prompt when entries are policy-only", async () => {
    const prompter = createPrompter({
      select: "allowlist",
      textError: "text prompt should not run",
    });

    const result = await promptChannelAccessConfig({
      prompter,
      label: "Twitch chat",
      skipAllowlistEntries: true,
    });

    expect(result).toEqual({ policy: "allowlist", entries: [] });
  });
});

describe("promptChannelAccessConfig policy selection", () => {
  it("returns non-allowlist policy with empty entries", async () => {
    const prompter = createPrompter({
      select: "open",
      textError: "open policy must not prompt for entries",
    });

    const result = await promptChannelAccessConfig({
      prompter,
      label: "Slack",
      allowDisabled: true,
    });

    expect(result).toEqual({
      policy: "open",
      entries: [],
    });
  });
});
