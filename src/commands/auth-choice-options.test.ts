// Auth-choice grouping tests consume prepared flow results; real metadata selection is tested separately.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthChoiceGroups,
  formatAuthChoiceChoicesForCli,
  isFeaturedAuthChoiceGroup,
} from "./auth-choice-options.js";
import { formatStaticAuthChoiceChoicesForCli } from "./auth-choice-options.static.js";

type ResolveProviderSetupFlowContributions =
  typeof import("../flows/provider-flow.js").resolveProviderSetupFlowContributions;
type ProviderSetupFlowContribution = ReturnType<ResolveProviderSetupFlowContributions>[number];

const resolveProviderSetupFlowContributions = vi.hoisted(() =>
  vi.fn<ResolveProviderSetupFlowContributions>(() => []),
);
vi.mock("../flows/provider-flow.js", () => ({ resolveProviderSetupFlowContributions }));

// A consumer fixture, not a metadata resolver: keep the supplied option and order unchanged.
function flowContribution(
  providerId: string,
  option: ProviderSetupFlowContribution["option"],
): ProviderSetupFlowContribution {
  return {
    id: `provider:setup:${option.value}`,
    kind: "provider",
    surface: "setup",
    providerId,
    option,
    source: "manifest",
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

  it.each([
    { assistantVisibleOnly: true, detected: false },
    { assistantVisibleOnly: false, detected: false },
    { assistantVisibleOnly: true, detected: true },
    { assistantVisibleOnly: false, detected: true },
  ])(
    "offers detected-only providers only after detection ($assistantVisibleOnly, $detected)",
    ({ assistantVisibleOnly, detected }) => {
      resolveProviderSetupFlowContributions.mockReturnValue([
        flowContribution("native", {
          value: "native-local",
          label: "Native local model",
          assistantVisibility: "detected-only",
          group: { id: "native", label: "Native" },
        }),
        flowContribution("other", {
          value: "other-api-key",
          label: "Other API key",
          group: { id: "other", label: "Other" },
        }),
      ]);
      const { groups } = buildAuthChoiceGroups({
        includeSkip: false,
        assistantVisibleOnly,
        detectedProviderIds: new Set(detected ? ["NATIVE"] : ["other"]),
      });
      expect(groups.some((group) => group.value === "native")).toBe(detected);
      expect(groups.some((group) => group.value === "other")).toBe(true);
      expect(formatAuthChoiceChoicesForCli().split("|")).toContain("native-local");
    },
  );

  it("builds cli help choices from the same prepared flow results", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      flowContribution("chutes", {
        value: "chutes",
        label: "Chutes (OAuth)",
      }),
      flowContribution("litellm", {
        value: "litellm-api-key",
        label: "LiteLLM API key",
      }),
      flowContribution("openai", {
        value: "openai-api-key",
        label: "OpenAI API key",
      }),
      flowContribution("ollama", {
        value: "ollama",
        label: "Ollama",
        hint: "Cloud and local open models",
        group: {
          id: "ollama",
          label: "Ollama",
        },
      }),
    ]);

    const options = getOptions(true);
    const cliChoices = formatAuthChoiceChoicesForCli({
      includeSkip: true,
    }).split("|");

    expect(cliChoices).toContain("openai-api-key");
    expect(cliChoices).toContain("chutes");
    expect(cliChoices).toContain("litellm-api-key");
    expect(cliChoices).toContain("custom-api-key");
    expect(cliChoices).toContain("skip");
    expect(options.map((option) => option.value)).toContain("ollama");
    expect(cliChoices).toContain("ollama");
  });

  it("keeps static cli help choices off the plugin-backed catalog", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      flowContribution("openai", {
        value: "openai-api-key",
        label: "OpenAI API key",
      }),
      flowContribution("ollama", {
        value: "ollama",
        label: "Ollama",
        hint: "Cloud and local open models",
        group: {
          id: "ollama",
          label: "Ollama",
        },
      }),
    ]);

    const cliChoices = formatStaticAuthChoiceChoicesForCli({ includeSkip: true }).split("|");

    expect(cliChoices).not.toContain("ollama");
    expect(cliChoices).not.toContain("openai-api-key");
    expect(cliChoices).not.toContain("chutes");
    expect(cliChoices).not.toContain("litellm-api-key");
    expect(cliChoices).toContain("custom-api-key");
    expect(cliChoices).toContain("skip");
  });

  it("orders common auth provider groups before the alphabetical remainder", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      flowContribution("google", {
        value: "gemini-api-key",
        label: "Gemini API key",
        group: {
          id: "google",
          label: "Google",
        },
      }),
      flowContribution("xai", {
        value: "xai-api-key",
        label: "xAI API key",
        group: {
          id: "xai",
          label: "xAI (Grok)",
        },
      }),
      flowContribution("litellm", {
        value: "litellm-api-key",
        label: "LiteLLM API key",
        group: {
          id: "litellm",
          label: "LiteLLM",
        },
      }),
      flowContribution("openai", {
        value: "openai-api-key",
        label: "OpenAI API key",
        group: {
          id: "openai",
          label: "OpenAI",
        },
      }),
      flowContribution("anthropic", {
        value: "apiKey",
        label: "Anthropic API key",
        group: {
          id: "anthropic",
          label: "Anthropic",
        },
      }),
      flowContribution("byteplus", {
        value: "byteplus-api-key",
        label: "BytePlus API key",
        group: {
          id: "byteplus",
          label: "BytePlus",
        },
      }),
      flowContribution("openrouter", {
        value: "openrouter-oauth",
        label: "OpenRouter OAuth",
        group: {
          id: "openrouter",
          label: "OpenRouter",
        },
      }),
      flowContribution("meta", {
        value: "meta-api-key",
        label: "Meta API key",
        group: {
          id: "meta",
          label: "Meta",
        },
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

  it("prefers Anthropic Claude CLI over API key in grouped selection", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      flowContribution("anthropic", {
        value: "apiKey",
        label: "Anthropic API key",
        group: {
          id: "anthropic",
          label: "Anthropic",
        },
      }),
      flowContribution("anthropic", {
        value: "anthropic-cli",
        label: "Anthropic Claude CLI",
        group: {
          id: "anthropic",
          label: "Anthropic",
        },
        assistantPriority: -20,
      }),
    ]);
    const { groups } = buildAuthChoiceGroups({
      includeSkip: false,
    });
    const anthropicGroup = requireChoiceGroup(groups, "anthropic");

    expect(anthropicGroup.options.map((option) => option.value)).toEqual([
      "anthropic-cli",
      "apiKey",
    ]);
  });

  it("groups OpenAI auth methods under one provider entry", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      flowContribution("openai", {
        value: "openai",
        label: "ChatGPT Login",
        group: {
          id: "openai",
          label: "OpenAI",
        },
        assistantPriority: -40,
        assistantVisibility: "manual-only",
      }),
      flowContribution("openai", {
        value: "openai-device-code",
        label: "ChatGPT Device Pairing",
        group: {
          id: "openai",
          label: "OpenAI",
        },
        assistantPriority: -10,
        assistantVisibility: "manual-only",
      }),
      flowContribution("openai", {
        value: "openai-api-key",
        label: "OpenAI API Key",
        group: {
          id: "openai",
          label: "OpenAI",
        },
        assistantPriority: 5,
      }),
      flowContribution("openai", {
        value: "openai",
        label: "ChatGPT/Codex Browser Login",
        group: {
          id: "openai",
          label: "OpenAI",
        },
        assistantPriority: -30,
        onboardingFeatured: true,
      }),
      flowContribution("openai", {
        value: "openai-chatgpt-device-code",
        label: "ChatGPT/Codex Device Pairing",
        group: {
          id: "openai",
          label: "OpenAI",
        },
        assistantPriority: -10,
      }),
    ]);

    const { groups } = buildAuthChoiceGroups({
      includeSkip: false,
    });
    const openAIGroup = requireChoiceGroup(groups, "openai");

    expect(openAIGroup.options.map((option) => option.value)).toEqual([
      "openai",
      "openai-chatgpt-device-code",
      "openai-api-key",
    ]);
    expect(openAIGroup.providerIds).toEqual(["openai"]);
    expect(openAIGroup.options[0]?.onboardingFeatured).toBe(true);
  });

  it("includes manual-only methods when the grouped CLI picker requests them", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      flowContribution("openai", {
        value: "openai-device-code",
        label: "ChatGPT Device Pairing",
        group: {
          id: "openai",
          label: "OpenAI",
        },
        assistantPriority: -10,
        assistantVisibility: "manual-only",
      }),
      flowContribution("openai", {
        value: "openai-api-key",
        label: "OpenAI API Key",
        group: {
          id: "openai",
          label: "OpenAI",
        },
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
      flowContribution("opencode", {
        value: "opencode-zen",
        label: "OpenCode Zen catalog",
        group: {
          id: "opencode",
          label: "OpenCode",
        },
      }),
      flowContribution("opencode-go", {
        value: "opencode-go",
        label: "OpenCode Go catalog",
        group: {
          id: "opencode",
          label: "OpenCode",
        },
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
        flowContribution("openai", {
          value: "openai-api-key",
          label: "OpenAI API key",
          group: {
            id: "openai",
            label: "OpenAI",
          },
        }),
        flowContribution("ollama", {
          value: "ollama",
          label: "Ollama",
          group: {
            id: "ollama",
            label: "Ollama",
          },
        }),
      ])
      .mockReturnValueOnce([
        flowContribution("fal", {
          value: "fal-api-key",
          label: "fal API key",
          group: {
            id: "fal",
            label: "fal",
          },
        }),
        flowContribution("vydra", {
          value: "vydra-api-key",
          label: "Vydra API key",
          group: {
            id: "vydra",
            label: "Vydra",
          },
        }),
        flowContribution("openrouter", {
          value: "openrouter-api-key",
          label: "OpenRouter API key",
          group: {
            id: "openrouter",
            label: "OpenRouter",
          },
        }),
        flowContribution("openai", {
          value: "openai-api-key",
          label: "OpenAI API key",
          group: {
            id: "openai",
            label: "OpenAI",
          },
        }),
        flowContribution("local-image-runtime", {
          value: "local-image-runtime",
          label: "Local image runtime",
          group: {
            id: "local-image-runtime",
            label: "Local image runtime",
          },
        }),
        flowContribution("local-music-runtime", {
          value: "local-music-runtime",
          label: "Local music runtime",
          group: {
            id: "local-music-runtime",
            label: "Local music runtime",
          },
        }),
        flowContribution("ollama", {
          value: "ollama",
          label: "Ollama",
          group: {
            id: "ollama",
            label: "Ollama",
          },
        }),
      ]);

    const options = getOptions();
    const optionValues = options.map((option) => option.value);
    const cliChoiceValues = formatAuthChoiceChoicesForCli({
      includeSkip: true,
    }).split("|");

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
