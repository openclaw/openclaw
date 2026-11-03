// Auth-choice grouping tests consume prepared flow results; real metadata selection is tested separately.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthChoiceGroups,
  formatAuthChoiceChoicesForCli,
  isFeaturedAuthChoiceGroup,
} from "./auth-choice-options.js";

type ResolveProviderSetupFlowContributions =
  typeof import("../flows/provider-flow.js").resolveProviderSetupFlowContributions;
type ProviderSetupFlowContribution = ReturnType<ResolveProviderSetupFlowContributions>[number];

const resolveProviderSetupFlowContributions = vi.hoisted(() =>
  vi.fn<ResolveProviderSetupFlowContributions>(() => []),
);
vi.mock("../flows/provider-flow.js", () => ({ resolveProviderSetupFlowContributions }));

function groupedFlow(
  providerId: string,
  value: string,
  label: string,
  groupLabel = label,
  extra: Partial<ProviderSetupFlowContribution["option"]> = {},
): ProviderSetupFlowContribution {
  return {
    providerId,
    option: { value, label, group: { id: providerId, label: groupLabel }, ...extra },
  };
}

function getOptions(includeSkip = false) {
  const { groups, skipOption } = buildAuthChoiceGroups({
    includeSkip,
    assistantVisibleOnly: false,
  });
  return [...groups.flatMap((group) => group.options), ...(skipOption ? [skipOption] : [])];
}

function requireChoiceGroup(
  groups: ReturnType<typeof buildAuthChoiceGroups>["groups"],
  value: string,
) {
  const group = groups.find((entry) => entry.value === value);
  if (!group) {
    throw new Error(`expected auth choice group ${value}`);
  }
  return group;
}

describe("buildAuthChoiceOptions", () => {
  beforeEach(() => {
    resolveProviderSetupFlowContributions.mockReset();
  });

  it("offers a detected-only provider after detection", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      groupedFlow("native", "native-local", "Native local model", "Native", {
        assistantVisibility: "detected-only",
      }),
      groupedFlow("other", "other-api-key", "Other API key", "Other"),
    ]);
    const { groups } = buildAuthChoiceGroups({
      includeSkip: false,
      assistantVisibleOnly: true,
      detectedProviderIds: new Set(["NATIVE"]),
    });
    expect(groups.some((group) => group.value === "native")).toBe(true);
    expect(groups.some((group) => group.value === "other")).toBe(true);
    expect(formatAuthChoiceChoicesForCli().split("|")).toContain("native-local");
  });

  it("builds cli help choices from the same prepared flow results", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      { providerId: "chutes", option: { value: "chutes", label: "Chutes (OAuth)" } },
      { providerId: "litellm", option: { value: "litellm-api-key", label: "LiteLLM API key" } },
      { providerId: "openai", option: { value: "openai-api-key", label: "OpenAI API key" } },
      groupedFlow("ollama", "ollama", "Ollama", "Ollama", {
        hint: "Cloud and local open models",
      }),
    ]);

    const options = getOptions(true);
    const cliChoices = formatAuthChoiceChoicesForCli().split("|");

    expect(cliChoices).toEqual(
      expect.arrayContaining([
        "openai-api-key",
        "chutes",
        "litellm-api-key",
        "custom-api-key",
        "skip",
        "ollama",
      ]),
    );
    expect(options.map((option) => option.value)).toContain("ollama");
  });

  it("orders common auth provider groups before the alphabetical remainder", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      groupedFlow("google", "gemini-api-key", "Gemini API key", "Google"),
      groupedFlow("xai", "xai-api-key", "xAI API key", "xAI (Grok)"),
      groupedFlow("litellm", "litellm-api-key", "LiteLLM API key", "LiteLLM"),
      groupedFlow("openai", "openai-api-key", "OpenAI API key", "OpenAI"),
      groupedFlow("anthropic", "apiKey", "Anthropic API key", "Anthropic"),
      groupedFlow("byteplus", "byteplus-api-key", "BytePlus API key", "BytePlus"),
      groupedFlow("openrouter", "openrouter-oauth", "OpenRouter OAuth", "OpenRouter"),
      groupedFlow("meta", "meta-api-key", "Meta API key", "Meta", {
        onboardingFeatured: true,
      }),
    ]);

    const { groups } = buildAuthChoiceGroups({
      includeSkip: false,
    });

    expect(groups.map((group) => group.label)).toEqual([
      "OpenAI",
      "OpenRouter",
      "xAI (Grok)",
      "Google",
      "Anthropic",
      "BytePlus",
      "Custom Provider",
      "LiteLLM",
      "Meta",
    ]);
    expect(groups.filter(isFeaturedAuthChoiceGroup).map((group) => group.label)).toEqual([
      "OpenAI",
      "OpenRouter",
      "xAI (Grok)",
      "Google",
      "Anthropic",
    ]);
  });

  it("includes manual-only methods when the grouped CLI picker requests them", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      groupedFlow("openai", "openai-device-code", "ChatGPT Device Pairing", "OpenAI", {
        assistantPriority: -10,
        assistantVisibility: "manual-only",
      }),
      groupedFlow("openai", "openai-api-key", "OpenAI API Key", "OpenAI", {
        assistantPriority: 5,
      }),
    ]);

    const { groups } = buildAuthChoiceGroups({
      includeSkip: false,
      assistantVisibleOnly: false,
    });

    expect(requireChoiceGroup(groups, "openai").options.map((option) => option.value)).toEqual([
      "openai-device-code",
      "openai-api-key",
    ]);
  });

  it("groups OpenCode Zen and Go under one OpenCode entry", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      groupedFlow("opencode", "opencode-zen", "OpenCode Zen catalog", "OpenCode"),
      groupedFlow("opencode-go", "opencode-go", "OpenCode Go catalog", "OpenCode", {
        group: { id: "opencode", label: "OpenCode" },
      }),
    ]);
    const { groups } = buildAuthChoiceGroups({
      includeSkip: false,
    });
    const openCodeGroup = requireChoiceGroup(groups, "opencode");

    const openCodeValues = openCodeGroup.options.map((option) => option.value);
    expect(openCodeValues).toContain("opencode-zen");
    expect(openCodeValues).toContain("opencode-go");
  });

  it("keeps media-generation auth choices available to the CLI but out of the interactive picker", () => {
    resolveProviderSetupFlowContributions
      .mockReturnValueOnce([
        groupedFlow("openai", "openai-api-key", "OpenAI API key", "OpenAI"),
        groupedFlow("ollama", "ollama", "Ollama", "Ollama"),
      ])
      .mockReturnValueOnce([
        groupedFlow("fal", "fal-api-key", "fal API key", "fal"),
        groupedFlow("vydra", "vydra-api-key", "Vydra API key", "Vydra"),
        groupedFlow("openrouter", "openrouter-api-key", "OpenRouter API key", "OpenRouter"),
        groupedFlow("openai", "openai-api-key", "OpenAI API key", "OpenAI"),
        groupedFlow("local-image-runtime", "local-image-runtime", "Local image runtime"),
        groupedFlow("local-music-runtime", "local-music-runtime", "Local music runtime"),
        groupedFlow("ollama", "ollama", "Ollama", "Ollama"),
      ]);

    const options = getOptions();
    const optionValues = options.map((option) => option.value);
    const cliChoiceValues = formatAuthChoiceChoicesForCli().split("|");

    expect(optionValues).toContain("openai-api-key");
    expect(optionValues).toContain("ollama");
    expect(optionValues).not.toContain("fal-api-key");
    expect(optionValues).not.toContain("vydra-api-key");
    expect(optionValues).not.toContain("openrouter-api-key");
    expect(optionValues).not.toContain("local-image-runtime");
    expect(optionValues).not.toContain("local-music-runtime");
    expect(cliChoiceValues).toEqual(
      expect.arrayContaining([
        "openai-api-key",
        "fal-api-key",
        "vydra-api-key",
        "openrouter-api-key",
      ]),
    );
    expect(cliChoiceValues.filter((choice) => choice === "fal-api-key")).toHaveLength(1);
    expect(resolveProviderSetupFlowContributions).toHaveBeenCalledTimes(2);
    expect(resolveProviderSetupFlowContributions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ scope: "text-inference" }),
    );
    expect(resolveProviderSetupFlowContributions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ scope: "all" }),
    );
  });
});
