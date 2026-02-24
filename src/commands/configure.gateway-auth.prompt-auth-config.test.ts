import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  promptAuthChoiceGrouped: vi.fn(),
  applyAuthChoice: vi.fn(),
  promptModelAllowlist: vi.fn(),
  promptDefaultModel: vi.fn(),
  promptCustomApiConfig: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
}));

vi.mock("./auth-choice-prompt.js", () => ({
  promptAuthChoiceGrouped: mocks.promptAuthChoiceGrouped,
}));

vi.mock("./auth-choice.js", () => ({
  applyAuthChoice: mocks.applyAuthChoice,
  resolvePreferredProviderForAuthChoice: vi.fn(() => undefined),
}));

vi.mock("./model-picker.js", async (importActual) => {
  const actual = await importActual<typeof import("./model-picker.js")>();
  return {
    ...actual,
    promptModelAllowlist: mocks.promptModelAllowlist,
    promptDefaultModel: mocks.promptDefaultModel,
  };
});

vi.mock("./onboard-custom.js", () => ({
  promptCustomApiConfig: mocks.promptCustomApiConfig,
}));

import { promptAuthConfig } from "./configure.gateway-auth.js";

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

const noopPrompter = {} as WizardPrompter;

describe("promptAuthConfig", () => {
  it("prunes Kilo provider models to selected allowlist entries", async () => {
    mocks.promptAuthChoiceGrouped.mockResolvedValue("kilocode-api-key");
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: { primary: "kilocode/anthropic/claude-opus-4.6" },
          },
        },
        models: {
          providers: {
            kilocode: {
              baseUrl: "https://api.kilo.ai/api/gateway/",
              api: "openai-completions",
              models: [
                { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
                { id: "minimax/minimax-m2.5:free", name: "MiniMax M2.5 (Free)" },
              ],
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({
      models: ["kilocode/anthropic/claude-opus-4.6"],
    });

    const result = await promptAuthConfig({}, makeRuntime(), noopPrompter);
    expect(result.models?.providers?.kilocode?.models?.map((model) => model.id)).toEqual([
      "anthropic/claude-opus-4.6",
    ]);
    expect(Object.keys(result.agents?.defaults?.models ?? {})).toEqual([
      "kilocode/anthropic/claude-opus-4.6",
    ]);
  });

  it("does not mutate non-Kilo provider models when allowlist contains Kilo entries", async () => {
    mocks.promptAuthChoiceGrouped.mockResolvedValue("kilocode-api-key");
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: { primary: "kilocode/anthropic/claude-opus-4.6" },
          },
        },
        models: {
          providers: {
            kilocode: {
              baseUrl: "https://api.kilo.ai/api/gateway/",
              api: "openai-completions",
              models: [
                { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
                { id: "minimax/minimax-m2.5:free", name: "MiniMax M2.5 (Free)" },
              ],
            },
            minimax: {
              baseUrl: "https://api.minimax.io/anthropic",
              api: "anthropic-messages",
              models: [{ id: "MiniMax-M2.1", name: "MiniMax M2.1" }],
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({
      models: ["kilocode/anthropic/claude-opus-4.6"],
    });

    const result = await promptAuthConfig({}, makeRuntime(), noopPrompter);
    expect(result.models?.providers?.kilocode?.models?.map((model) => model.id)).toEqual([
      "anthropic/claude-opus-4.6",
    ]);
    expect(result.models?.providers?.minimax?.models?.map((model) => model.id)).toEqual([
      "MiniMax-M2.1",
    ]);
  });
});
