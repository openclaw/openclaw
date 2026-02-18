import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  buildAuthChoiceGroups,
  buildAuthChoiceOptions,
  formatAuthChoiceChoicesForCli,
} from "./auth-choice-options.js";

const EMPTY_STORE: AuthProfileStore = { version: 1, profiles: {} };

function getOptions(includeSkip = false) {
  return buildAuthChoiceOptions({
    store: EMPTY_STORE,
    includeSkip,
  });
}

describe("buildAuthChoiceOptions", () => {
  it("includes GitHub Copilot", () => {
    const options = getOptions();

    expect(options.find((opt) => opt.value === "github-copilot")).toBeDefined();
  });

  it("includes setup-token option for Anthropic", () => {
    const options = getOptions();

    expect(options.some((opt) => opt.value === "token")).toBe(true);
  });

  it.each([
    ["Z.AI (GLM) auth choice", ["zai-api-key"]],
    ["Xiaomi auth choice", ["xiaomi-api-key"]],
    ["MiniMax auth choice", ["minimax-api", "minimax-api-key-cn", "minimax-api-lightning"]],
    [
      "Moonshot auth choice",
      ["moonshot-api-key", "moonshot-api-key-cn", "kimi-code-api-key", "together-api-key"],
    ],
    ["Vercel AI Gateway auth choice", ["ai-gateway-api-key"]],
    ["Cloudflare AI Gateway auth choice", ["cloudflare-ai-gateway-api-key"]],
    ["Together AI auth choice", ["together-api-key"]],
    ["Synthetic auth choice", ["synthetic-api-key"]],
    ["Chutes OAuth auth choice", ["chutes"]],
    ["Qwen auth choice", ["qwen-portal"]],
    ["xAI auth choice", ["xai-api-key"]],
    ["vLLM auth choice", ["vllm"]],
  ])("includes %s", (_label, expectedValues) => {
    const options = getOptions();

    for (const value of expectedValues) {
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
});
