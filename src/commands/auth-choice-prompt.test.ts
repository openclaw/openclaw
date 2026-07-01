// Grouped auth-choice prompt tests cover configured-provider setup affordances.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { WizardPrompter, WizardSelectParams } from "../wizard/prompts.js";
import type { AuthChoiceGroup } from "./auth-choice-options.static.js";
import { KEEP_CURRENT_AUTH_CHOICE, promptAuthChoiceGrouped } from "./auth-choice-prompt.js";

const buildAuthChoiceGroups = vi.hoisted(() => vi.fn());
const compareAuthChoiceGroups = vi.hoisted(() =>
  vi.fn((a: AuthChoiceGroup, b: AuthChoiceGroup) => a.label.localeCompare(b.label)),
);

vi.mock("./auth-choice-options.js", () => ({
  buildAuthChoiceGroups,
  compareAuthChoiceGroups,
}));

const EMPTY_STORE: AuthProfileStore = { version: 1, profiles: {} };

function createPromptHarness(
  onSelect: (params: WizardSelectParams<unknown>) => Promise<unknown>,
): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(onSelect) as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({
      update: vi.fn(),
      stop: vi.fn(),
    })),
  };
}

function openAIGroup(options?: Partial<AuthChoiceGroup>): AuthChoiceGroup {
  return {
    value: "openai",
    label: "OpenAI",
    providerIds: ["openai"],
    options: [
      {
        value: "openai",
        label: "ChatGPT Login",
        onboardingFeatured: true,
      },
      {
        value: "openai-api-key",
        label: "OpenAI API Key",
      },
    ],
    ...options,
  };
}

describe("promptAuthChoiceGrouped", () => {
  beforeEach(() => {
    buildAuthChoiceGroups.mockReset();
    compareAuthChoiceGroups.mockClear();
  });

  it("marks the configured provider and offers keep current config first", async () => {
    buildAuthChoiceGroups.mockReturnValue({
      groups: [
        openAIGroup(),
        {
          value: "anthropic",
          label: "Anthropic",
          providerIds: ["anthropic"],
          options: [
            {
              value: "apiKey",
              label: "Anthropic API Key",
              onboardingFeatured: true,
            },
          ],
        },
      ],
      skipOption: { value: "skip", label: "Skip for now" },
    });
    let providerOptions: Array<{ value: unknown; label: string; hint?: string }> = [];
    let methodOptions: Array<{ value: unknown; label: string; hint?: string }> = [];
    const prompter = createPromptHarness(async (params) => {
      if (params.message === "Model/auth provider") {
        providerOptions = params.options;
        return "openai";
      }
      if (params.message === "OpenAI auth method") {
        methodOptions = params.options;
        return KEEP_CURRENT_AUTH_CHOICE;
      }
      throw new Error(`unexpected prompt ${params.message}`);
    });

    const result = await promptAuthChoiceGrouped({
      prompter,
      store: EMPTY_STORE,
      includeSkip: true,
      allowKeepCurrentProvider: true,
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
            },
          },
        },
      },
    });

    expect(result).toBe(KEEP_CURRENT_AUTH_CHOICE);
    expect(providerOptions).toContainEqual({
      value: "openai",
      label: "OpenAI (currently configured)",
      hint: undefined,
    });
    expect(methodOptions[0]).toEqual({
      value: KEEP_CURRENT_AUTH_CHOICE,
      label: "Keep current config",
      hint: "Keep openai/gpt-5.5",
    });
    expect(methodOptions.map((option) => option.value)).toEqual([
      KEEP_CURRENT_AUTH_CHOICE,
      "openai",
      "openai-api-key",
      "__back",
    ]);
  });

  it("does not show keep current config for a different provider", async () => {
    buildAuthChoiceGroups.mockReturnValue({
      groups: [openAIGroup()],
      skipOption: { value: "skip", label: "Skip for now" },
    });
    let providerOptions: Array<{ value: unknown; label: string; hint?: string }> = [];
    let methodOptions: Array<{ value: unknown; label: string; hint?: string }> = [];
    const prompter = createPromptHarness(async (params) => {
      if (params.message === "Model/auth provider") {
        providerOptions = params.options;
        return "openai";
      }
      if (params.message === "OpenAI auth method") {
        methodOptions = params.options;
        return "openai-api-key";
      }
      throw new Error(`unexpected prompt ${params.message}`);
    });

    const result = await promptAuthChoiceGrouped({
      prompter,
      store: EMPTY_STORE,
      includeSkip: true,
      allowKeepCurrentProvider: true,
      config: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-sonnet-4.6",
            },
          },
        },
      },
    });

    expect(result).toBe("openai-api-key");
    expect(providerOptions).toContainEqual({
      value: "openai",
      label: "OpenAI",
      hint: undefined,
    });
    expect(methodOptions.map((option) => option.value)).toEqual([
      "openai",
      "openai-api-key",
      "__back",
    ]);
  });
});
