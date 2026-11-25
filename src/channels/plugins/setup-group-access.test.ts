// Setup group access tests cover group access setup flow decisions and outputs.
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { promptChannelAccessConfig } from "./setup-group-access.js";

function createPrompter(params?: {
  confirm?: boolean;
  select?: string;
  text?: string;
  textError?: string;
}) {
  const confirm = vi.fn(async () => params?.confirm ?? true);
  const text = vi.fn(async () => {
    if (params?.textError) {
      throw new Error(params.textError);
    }
    return params?.text ?? "";
  });
  const prompter = createWizardPrompter(
    { confirm, text },
    { defaultSelect: params?.select ?? "allowlist" },
  );
  return {
    ...prompter,
    confirm,
    select: vi.mocked(prompter.select),
    text,
  };
}

describe("promptChannelAccessConfig policy-only entries", () => {
  it("skips the allowlist text prompt when entries are policy-only", async () => {
    const prompter = createPrompter({
      confirm: true,
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
      confirm: true,
      select: "open",
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
