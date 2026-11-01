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
  groupValue: string,
  groupLabel: string,
  methods: Array<readonly [value: string, label: string]>,
): AuthChoiceGroup {
  return {
    value: groupValue,
    label: groupLabel,
    options: methods.map(([value, label]) => ({ value, label })),
  };
}

function openAIGroup(): AuthChoiceGroup {
  return authChoiceGroup("openai", "OpenAI", [
    ["openai", "ChatGPT Login"],
    ["openai-api-key", "OpenAI API Key"],
  ]);
}

function mockGroups(groups: AuthChoiceGroup[]) {
  buildAuthChoiceGroups.mockReturnValue({
    groups,
    skipOption: { value: "skip", label: "Skip for now" },
  });
}

function scriptedPrompter(
  steps: ReadonlyArray<string | readonly [message: string, answer: string, searchable?: true]>,
  unmatchedAnswers: readonly string[] = [],
) {
  const prompts: WizardSelectParams<unknown>[] = [];
  const select = async (params: WizardSelectParams<unknown>) => {
    const step = steps[prompts.length];
    if (!step) {
      throw new Error(`unexpected prompt ${params.message}`);
    }
    if (typeof step !== "string") {
      expect([params.message, params.searchable]).toEqual([step[0], step[2]]);
    }
    const answer = typeof step === "string" ? step : step[1];
    if (!unmatchedAnswers.includes(answer)) {
      expect(optionValues(params)).toContain(answer);
    }
    prompts.push(params);
    return answer;
  };
  const prompter = makePrompter({ select: vi.fn(select) as WizardPrompter["select"] });
  return { prompter, prompts };
}

function optionValues(prompt: WizardSelectParams<unknown> | undefined) {
  return prompt?.options.map((option) => option.value);
}

const providerSearchMessage =
  "Model/auth provider\nProvider not listed? Find community provider plugins at https://clawhub.ai/plugins";

describe("promptAuthChoiceGrouped", () => {
  beforeEach(() => {
    buildAuthChoiceGroups.mockReset();
  });

  it("marks the configured provider and offers keep current config first", async () => {
    mockGroups([
      openAIGroup(),
      authChoiceGroup("anthropic", "Anthropic", [["apiKey", "Anthropic API Key"]]),
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
      authChoiceGroup("meta", "Meta", [["meta-api-key", "Meta API key"]]),
      openAIGroup(),
      authChoiceGroup("anthropic", "Anthropic", [["apiKey", "Anthropic API key"]]),
    ]);
    const { prompter, prompts } = scriptedPrompter([
      ["Model/auth provider", "__more"],
      "minimax",
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
      authChoiceGroup("anthropic", "Anthropic", [["apiKey", "Anthropic API key"]]),
      authChoiceGroup("minimax", "MiniMax", [["minimax-api", "MiniMax API key"]]),
    ]);
    const { prompter, prompts } = scriptedPrompter([["Model/auth provider", "__more"], "minimax"]);

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

  it.each([true, false])(
    "keeps the ClawHub hint on searchable provider pages through recovery and Back (featured=%s)",
    async (featured) => {
      const steps = featured
        ? ([
            ["Model/auth provider", "__more"],
            [providerSearchMessage, "missing", true],
            [providerSearchMessage, "minimax", true],
            ["MiniMax auth method", "__back"],
            [providerSearchMessage, "__back", true],
            ["Model/auth provider", "skip"],
          ] as const)
        : ([
            [providerSearchMessage, "minimax", true],
            ["MiniMax auth method", "__back"],
            [providerSearchMessage, "missing", true],
            [providerSearchMessage, "skip", true],
          ] as const);
      mockGroups([
        ...(featured ? [openAIGroup()] : []),
        authChoiceGroup("minimax", "MiniMax", [
          ["minimax-global-api", "Global API key"],
          ["minimax-cn-api", "CN API key"],
        ]),
      ]);
      const { prompter, prompts } = scriptedPrompter(steps, ["missing"]);

      expect(await promptAuthChoiceGrouped({ prompter, includeSkip: true })).toBe("skip");
      expect(prompts).toHaveLength(steps.length);
      expect(prompter.note).toHaveBeenCalledTimes(featured ? 0 : 1);
      expect(prompts.at(-1)?.options.at(-1)?.value).toBe("skip");
    },
  );
});
