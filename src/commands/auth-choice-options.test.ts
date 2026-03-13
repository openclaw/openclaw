import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { ProviderWizardOption } from "../plugins/provider-wizard.js";
import {
  buildAuthChoiceGroups,
  buildAuthChoiceOptions,
  formatAuthChoiceChoicesForCli,
} from "./auth-choice-options.js";

const resolveProviderWizardOptions = vi.hoisted(() =>
  vi.fn<() => ProviderWizardOption[]>(() => []),
);
vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderWizardOptions,
}));

const EMPTY_STORE: AuthProfileStore = { version: 1, profiles: {} };

function getOptions(includeSkip = false) {
  return buildAuthChoiceOptions({
    store: EMPTY_STORE,
    includeSkip,
  });
}

describe("buildAuthChoiceOptions", () => {
  it("includes core and provider-specific auth choices", () => {
    resolveProviderWizardOptions.mockReturnValue([
      {
        value: "ollama",
        label: "Ollama",
        hint: "Cloud and local open models",
        groupId: "ollama",
        groupLabel: "Ollama",
      },
      {
        value: "vllm",
        label: "vLLM",
        hint: "Local/self-hosted OpenAI-compatible server",
        groupId: "vllm",
        groupLabel: "vLLM",
      },
      {
        value: "sglang",
        label: "SGLang",
        hint: "Fast self-hosted OpenAI-compatible server",
        groupId: "sglang",
        groupLabel: "SGLang",
      },
    ]);
    const options = getOptions();

    for (const value of [
      "github-copilot",
      "token",
      "zai-api-key",
      "xiaomi-api-key",
      "minimax-global-api",
      "minimax-cn-api",
      "minimax-global-oauth",
      "moonshot-api-key",
      "moonshot-api-key-cn",
      "kimi-code-api-key",
      "together-api-key",
      "ai-gateway-api-key",
      "cloudflare-ai-gateway-api-key",
      "synthetic-api-key",
      "chutes",
      "qwen-portal",
      "xai-api-key",
      "mistral-api-key",
      "aiping-api-key",
      "volcengine-api-key",
      "byteplus-api-key",
      "vllm",
      "opencode-go",
      "ollama",
      "sglang",
    ]) {
      expect(options.some((opt) => opt.value === value)).toBe(true);
    }
  });

  it("builds cli help choices from the same catalog", () => {
    const options = getOptions(true);
    const cliChoices = formatAuthChoiceChoicesForCli({
      includeLegacyAliases: false,
      includeSkip: true,
    }).split("|");

    for (const option of options) {
      expect(cliChoices).toContain(option.value);
    }
  });

  it("can include legacy aliases in cli help choices", () => {
    const cliChoices = formatAuthChoiceChoicesForCli({
      includeLegacyAliases: true,
      includeSkip: true,
    }).split("|");

    expect(cliChoices).toContain("setup-token");
    expect(cliChoices).toContain("oauth");
    expect(cliChoices).toContain("claude-cli");
    expect(cliChoices).toContain("codex-cli");
  });

  it("shows Chutes in grouped provider selection", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const chutesGroup = groups.find((group) => group.value === "chutes");

    expect(chutesGroup).toBeDefined();
    expect(chutesGroup?.options.some((opt) => opt.value === "chutes")).toBe(true);
  });

  it("groups OpenCode Zen and Go under one OpenCode entry", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const openCodeGroup = groups.find((group) => group.value === "opencode");

    expect(openCodeGroup).toBeDefined();
    expect(openCodeGroup?.options.some((opt) => opt.value === "opencode-zen")).toBe(true);
    expect(openCodeGroup?.options.some((opt) => opt.value === "opencode-go")).toBe(true);
  });

  it("shows Ollama in grouped provider selection", () => {
    resolveProviderWizardOptions.mockReturnValue([
      {
        value: "ollama",
        label: "Ollama",
        hint: "Cloud and local open models",
        groupId: "ollama",
        groupLabel: "Ollama",
      },
    ]);
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const ollamaGroup = groups.find((group) => group.value === "ollama");

    expect(ollamaGroup).toBeDefined();
    expect(ollamaGroup?.options.some((opt) => opt.value === "ollama")).toBe(true);
  });
});
