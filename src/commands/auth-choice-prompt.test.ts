import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter, WizardSelectParams } from "../wizard/prompts.js";
import type { AuthChoiceGroup } from "./auth-choice-options.static.js";
import { isKeepCurrentAuthChoice, promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const buildAuthChoiceGroups = vi.hoisted(() => vi.fn());

vi.mock("./auth-choice-options.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-choice-options.js")>()),
  buildAuthChoiceGroups,
}));

function authChoiceGroup(
  value: string,
  label: string,
  methods: Array<readonly [value: string, label: string]>,
  featured = false,
): AuthChoiceGroup {
  return {
    value,
    label,
    options: methods.map(([methodValue, methodLabel], index) => ({
      value: methodValue,
      label: methodLabel,
      ...(featured && index === 0 ? { onboardingFeatured: true } : {}),
    })),
  };
}

function openAIGroup(): AuthChoiceGroup {
  const methods: Array<readonly [string, string]> = [
    ["openai", "ChatGPT Login"],
    ["openai-api-key", "OpenAI API Key"],
  ];
  return {
    ...authChoiceGroup("openai", "OpenAI", methods, true),
    providerIds: ["openai"],
  };
}

function mockGroups(groups: AuthChoiceGroup[]) {
  buildAuthChoiceGroups.mockReturnValue({
    groups,
    skipOption: { value: "skip", label: "Skip for now" },
  });
}

function scriptedPrompter(steps: Array<string | readonly [message: string, answer: string]>) {
  const prompts: WizardSelectParams<unknown>[] = [];
  const select = async (params: WizardSelectParams<unknown>) => {
    const step = steps[prompts.length];
    if (!step || (typeof step !== "string" && step[0] !== params.message)) {
      throw new Error(`unexpected prompt ${params.message}`);
    }
    prompts.push(params);
    return typeof step === "string" ? step : step[1];
  };
  const prompter = makePrompter({
    select: vi.fn(select) as WizardPrompter["select"],
    confirm: vi.fn(async () => true),
  });
  return { prompter, prompts };
}

function optionValues(prompt: WizardSelectParams<unknown> | undefined) {
  return prompt?.options.map((option) => option.value);
}

describe("promptAuthChoiceGrouped", () => {
  beforeEach(() => {
    buildAuthChoiceGroups.mockReset();
  });

  it("marks the configured provider and offers keep current config first", async () => {
    mockGroups([
      openAIGroup(),
      {
        ...authChoiceGroup("anthropic", "Anthropic", [["apiKey", "Anthropic API Key"]], true),
        providerIds: ["anthropic"],
      },
    ]);
    const { prompter, prompts } = scriptedPrompter([
      ["Model/auth provider", "openai"],
      ["OpenAI auth method", "__keep-current"],
    ]);

    const result = await promptAuthChoiceGrouped({
      prompter,
      includeSkip: true,
      allowKeepCurrentProvider: true,
      config: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    });

    expect(isKeepCurrentAuthChoice(result)).toBe(true);
    expect(prompts[0]?.options).toContainEqual({
      value: "openai",
      label: "OpenAI (currently configured)",
      hint: undefined,
    });
    expect(prompts[1]?.options[0]).toEqual({
      value: "__keep-current",
      label: "Keep current config",
      hint: "Keep openai/gpt-5.5",
    });
    expect(optionValues(prompts[1])).toEqual([
      "__keep-current",
      "openai",
      "openai-api-key",
      "__back",
    ]);
  });

  it("filters guided choices while keeping featured providers and grouped methods", async () => {
    mockGroups([
      authChoiceGroup("minimax", "MiniMax", [
        ["minimax-global-oauth", "MiniMax OAuth (Global)"],
        ["minimax-cn-api", "MiniMax API key (CN)"],
        ["minimax-legacy", "Legacy MiniMax login"],
      ]),
      authChoiceGroup("meta", "Meta", [["meta-api-key", "Meta API key"]], true),
      openAIGroup(),
      authChoiceGroup("anthropic", "Anthropic", [["apiKey", "Anthropic API key"]], true),
    ]);
    const { prompter, prompts } = scriptedPrompter([
      ["Model/auth provider", "__more"],
      ["Model/auth provider", "minimax"],
      ["MiniMax auth method", "minimax-cn-api"],
    ]);

    const result = await promptAuthChoiceGrouped({
      prompter,
      includeSkip: true,
      allowedChoices: new Set([
        "openai",
        "openai-api-key",
        "apiKey",
        "minimax-global-oauth",
        "minimax-cn-api",
        "meta-api-key",
      ]),
    });

    expect(optionValues(prompts[0])).toEqual(["openai", "anthropic", "__more", "skip"]);
    expect(optionValues(prompts[1])).toEqual(["meta", "minimax", "__back"]);
    expect(optionValues(prompts[2])).toEqual(["minimax-global-oauth", "minimax-cn-api", "__back"]);
    expect(result).toBe("minimax-cn-api");
  });

  it("features caller-supplied groups first and excludes them from More", async () => {
    mockGroups([
      openAIGroup(),
      authChoiceGroup("anthropic", "Anthropic", [["apiKey", "Anthropic API key"]], true),
      authChoiceGroup("minimax", "MiniMax", [["minimax-api", "MiniMax API key"]]),
    ]);
    const { prompter, prompts } = scriptedPrompter([
      ["Model/auth provider", "__more"],
      ["Model/auth provider", "minimax"],
    ]);

    const result = await promptAuthChoiceGrouped({
      prompter,
      includeSkip: true,
      additionalGroups: [
        {
          ...authChoiceGroup("detected-ai", "Detected AI", [["candidate:codex-cli", "Codex CLI"]]),
          hint: "Codex CLI",
        },
        authChoiceGroup("recommended-ai", "Recommended AI", [
          ["candidate:openai-api-key", "OpenAI API key"],
        ]),
      ],
    });

    expect(optionValues(prompts[0])).toEqual([
      "detected-ai",
      "recommended-ai",
      "openai",
      "anthropic",
      "__more",
      "skip",
    ]);
    expect(prompts[0]?.options[0]).toMatchObject({
      value: "detected-ai",
      hint: "Codex CLI",
    });
    expect(optionValues(prompts[1])).toEqual(["minimax", "__back"]);
    expect(result).toBe("minimax-api");
  });

  it("marks a detected provider in the provider picker", async () => {
    mockGroups([authChoiceGroup("ollama", "Ollama", [["ollama", "Ollama"]])]);
    const { prompter, prompts } = scriptedPrompter(["skip"]);

    await promptAuthChoiceGrouped({
      prompter,
      includeSkip: true,
      detectedProviderIds: new Set(["ollama"]),
    });

    expect(prompts[0]?.options).toContainEqual({
      value: "ollama",
      label: "Ollama (detected)",
      hint: undefined,
    });
  });

  it.each([
    {
      featured: true,
      answers: ["__more", "missing", "minimax", "__back", "__back", "skip"],
      searchable: [undefined, true, true, undefined, true, undefined],
      notes: 0,
    },
    {
      featured: false,
      answers: ["minimax", "__back", "missing", "skip"],
      searchable: [true, undefined, true, true],
      notes: 1,
    },
  ])(
    "keeps method Back on its provider page and returns More to the root (featured=$featured)",
    async ({ featured, answers, searchable, notes }) => {
      mockGroups([
        ...(featured ? [openAIGroup()] : []),
        authChoiceGroup("minimax", "MiniMax", [
          ["minimax-global-api", "Global API key"],
          ["minimax-cn-api", "CN API key"],
        ]),
      ]);
      const { prompter, prompts } = scriptedPrompter(answers);

      expect(await promptAuthChoiceGrouped({ prompter, includeSkip: true })).toBe("skip");
      expect(prompts.map((prompt) => prompt.searchable)).toEqual(searchable);
      expect(prompter.note).toHaveBeenCalledTimes(notes);
      expect(prompts.at(-1)?.options.at(-1)?.value).toBe("skip");
    },
  );
});
