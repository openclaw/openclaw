// Setup group access tests cover group access setup flow decisions and outputs.
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import {
  formatAllowlistEntries,
  parseAllowlistEntries,
  promptChannelAccessConfig,
  promptChannelAllowlist,
  promptChannelAccessPolicy,
} from "./setup-group-access.js";

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

describe("parseAllowlistEntries", () => {
  it("splits comma/newline/semicolon-separated entries", () => {
    expect(parseAllowlistEntries("alpha, beta\n gamma;delta")).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });
});

describe("formatAllowlistEntries", () => {
  it("formats compact comma-separated output", () => {
    expect(formatAllowlistEntries([" alpha ", "", "beta"])).toBe("alpha, beta");
  });
});

describe("promptChannelAllowlist", () => {
  it("uses existing entries as initial value", async () => {
    const prompter = createPrompter({
      text: "one,two",
    });

    const result = await promptChannelAllowlist({
      prompter,
      label: "Test",
      currentEntries: ["alpha", "beta"],
    });

    expect(result).toEqual(["one", "two"]);
    expect(prompter.text).toHaveBeenCalledWith({
      message: "Test allowlist (comma-separated)",
      placeholder: undefined,
      initialValue: "alpha, beta",
    });
  });
});

describe("promptChannelAccessPolicy", () => {
  it("returns selected policy", async () => {
    const prompter = createPrompter({
      select: "open",
    });

    const result = await promptChannelAccessPolicy({
      prompter,
      label: "Discord",
      currentPolicy: "allowlist",
    });

    expect(result).toBe("open");
  });
});

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

describe("promptChannelAccessConfig skip flow", () => {
  it("returns null when user skips configuration", async () => {
    const prompter = createPrompter({
      confirm: false,
    });

    const result = await promptChannelAccessConfig({
      prompter,
      label: "Slack",
    });

    expect(result).toBeNull();
  });

  it("returns allowlist entries when policy is allowlist", async () => {
    const prompter = createPrompter({
      confirm: true,
      select: "allowlist",
      text: "c1, c2",
    });

    const result = await promptChannelAccessConfig({
      prompter,
      label: "Slack",
    });

    expect(result).toEqual({
      policy: "allowlist",
      entries: ["c1", "c2"],
    });
  });

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
