import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { makePrompter } from "./onboarding/__tests__/test-utils.js";
import { promptDefaultModel } from "./model-picker.js";

const loadModelCatalog = vi.hoisted(() => vi.fn());
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog,
}));

const ensureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
);
const listProfilesForProvider = vi.hoisted(() => vi.fn(() => []));
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProfilesForProvider,
}));

const resolveEnvApiKey = vi.hoisted(() => vi.fn(() => undefined));
const getCustomProviderApiKey = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey,
  getCustomProviderApiKey,
}));

describe("promptDefaultModel", () => {
  it("filters internal router models from the selection list", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openrouter",
        id: "auto",
        name: "OpenRouter Auto",
      },
      {
        provider: "openrouter",
        id: "meta-llama/llama-3.3-70b:free",
        name: "Llama 3.3 70B",
      },
    ]);

    const select = vi.fn(async (params) => {
      const first = params.options[0];
      return first?.value ?? "";
    });
    const prompter = makePrompter({ select });
    const config = { agents: { defaults: {} } } as ClawdbotConfig;

    await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const options = select.mock.calls[0]?.[0]?.options ?? [];
    expect(options.some((opt) => opt.value === "openrouter/auto")).toBe(false);
    expect(
      options.some((opt) => opt.value === "openrouter/meta-llama/llama-3.3-70b:free"),
    ).toBe(true);
  });
});
