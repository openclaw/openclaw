import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter, WizardSelectParams } from "../wizard/prompts.js";
import {
  buildAuthChoiceGroups,
  formatAuthChoiceChoicesForCli,
  isFeaturedAuthChoiceGroup,
} from "./auth-choice-options.js";
import type { AuthChoiceGroup } from "./auth-choice-options.static.js";
import {
  isKeepCurrentAuthChoice,
  promptAuthChoiceGrouped as promptGrouped,
} from "./auth-choice-prompt.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

type ResolveFlows =
  typeof import("../flows/provider-flow.js").resolveProviderSetupFlowContributions;
type Flow = ReturnType<ResolveFlows>[number];
const resolveProviderSetupFlowContributions = vi.hoisted(() => vi.fn<ResolveFlows>(() => []));
vi.mock("../flows/provider-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/provider-flow.js")>()),
  resolveProviderSetupFlowContributions,
}));
let fixtureChoices: string[] = [];

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
  const flows = groups.flatMap((group) =>
    group.options.map((option) => ({
      providerId: group.providerIds?.[0] ?? group.value,
      option: { ...option, group: { id: group.value, label: group.label, hint: group.hint } },
    })),
  );
  fixtureChoices = flows.map(({ option }) => option.value);
  resolveProviderSetupFlowContributions.mockReturnValue(flows);
}

function promptAuthChoiceGrouped(params: Parameters<typeof promptGrouped>[0]) {
  return promptGrouped({ allowedChoices: new Set(fixtureChoices), ...params });
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

function flow(providerId: string, label: string, value = providerId, groupId = providerId): Flow {
  return { providerId, option: { value, label, group: { id: groupId, label } } };
}

describe("promptAuthChoiceGrouped", () => {
  beforeEach(() => {
    resolveProviderSetupFlowContributions.mockReset();
  });

  it("marks the configured provider and offers keep current config first", async () => {
    const openai = openAIGroup();
    openai.options.push({
      value: "openai-device-code",
      label: "ChatGPT Device Pairing",
      assistantVisibility: "manual-only",
      assistantPriority: -10,
    });
    mockGroups([
      openai,
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
      assistantVisibleOnly: false,
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
      "openai-device-code",
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
    expect(optionValues(prompts[2])).toEqual(["minimax-cn-api", "minimax-global-oauth", "__back"]);
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
    const ollama = authChoiceGroup("ollama", "Ollama", [["ollama", "Ollama"]]);
    ollama.options[0]!.assistantVisibility = "detected-only";
    mockGroups([ollama, openAIGroup()]);
    const { prompter, prompts } = scriptedPrompter(["skip"]);

    await promptAuthChoiceGrouped({
      prompter,
      includeSkip: true,
      detectedProviderIds: new Set(["OLLAMA"]),
    });

    expect(prompts[0]?.options).toContainEqual({
      value: "ollama",
      label: "Ollama (detected)",
      hint: undefined,
    });
    expect(optionValues(prompts[0])).toContain("openai");
  });

  it("orders common provider groups before the alphabetical remainder", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      ...(
        [
          ["google", "Google"],
          ["xai", "xAI (Grok)"],
          ["litellm", "LiteLLM"],
          ["openai", "OpenAI"],
          ["anthropic", "Anthropic"],
          ["byteplus", "BytePlus"],
          ["openrouter", "OpenRouter"],
        ] as const
      ).map(([id, label]) => flow(id, label)),
      {
        ...flow("meta", "Meta"),
        option: { ...flow("meta", "Meta").option, onboardingFeatured: true },
      },
    ]);
    const { groups } = buildAuthChoiceGroups({ includeSkip: false });
    expect(groups.map(({ label }) => label)).toEqual([
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
    expect(groups.filter(isFeaturedAuthChoiceGroup).map(({ label }) => label)).toEqual([
      "OpenAI",
      "OpenRouter",
      "xAI (Grok)",
      "Google",
      "Anthropic",
    ]);
  });

  it("groups OpenCode Zen and Go under one entry", () => {
    resolveProviderSetupFlowContributions.mockReturnValue([
      flow("opencode", "OpenCode", "opencode-zen"),
      flow("opencode-go", "OpenCode", "opencode-go", "opencode"),
    ]);
    const { groups } = buildAuthChoiceGroups({ includeSkip: false });
    expect(
      groups.find(({ value }) => value === "opencode")?.options.map(({ value }) => value),
    ).toEqual(expect.arrayContaining(["opencode-zen", "opencode-go"]));
  });

  it("keeps media auth choices in CLI help but outside the interactive picker", () => {
    const text = [flow("openai", "OpenAI", "openai-api-key"), flow("ollama", "Ollama")];
    const media = ["fal", "vydra", "openrouter"].map((id) => flow(id, id, `${id}-api-key`));
    const local = ["local-image-runtime", "local-music-runtime"].map((id) => flow(id, id));
    resolveProviderSetupFlowContributions
      .mockReturnValueOnce(text)
      .mockReturnValueOnce([...text, ...media, ...local]);
    const { groups, skipOption } = buildAuthChoiceGroups({
      includeSkip: true,
      assistantVisibleOnly: false,
    });
    const values = [
      ...groups.flatMap(({ options }) => options.map(({ value }) => value)),
      skipOption?.value,
    ];
    const cli = formatAuthChoiceChoicesForCli().split("|");
    expect(values).toEqual(expect.arrayContaining(["openai-api-key", "ollama", "skip"]));
    expect(
      values.filter((value) => [...media, ...local].some(({ option }) => option.value === value)),
    ).toEqual([]);
    expect(cli).toEqual(
      expect.arrayContaining([
        "openai-api-key",
        "fal-api-key",
        "vydra-api-key",
        "openrouter-api-key",
      ]),
    );
    expect(cli.filter((value) => value === "fal-api-key")).toHaveLength(1);
    expect(
      resolveProviderSetupFlowContributions.mock.calls.map(([params]) => params?.scope),
    ).toEqual(["text-inference", "all"]);
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
