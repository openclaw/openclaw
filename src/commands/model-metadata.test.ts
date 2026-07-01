import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  applyModelDefinitionUpdate,
  collectConfiguredModels,
  findModelInConfig,
  findPrimaryModelEntry,
  formatTokenCount,
  promptModelMetadata,
  promptModelMetadataForPrimary,
} from "./model-metadata.js";
import { createWizardPrompter } from "./test-wizard-helpers.js";

function makeModel(id: string, overrides?: Partial<ModelDefinitionConfig>): ModelDefinitionConfig {
  return {
    id,
    name: id,
    contextWindow: 128_000,
    maxTokens: 4096,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    ...overrides,
  };
}

function makeConfig(
  providers: Record<string, { baseUrl: string; models: ModelDefinitionConfig[] }>,
  primaryModel?: string,
): OpenClawConfig {
  const providersCfg: Record<
    string,
    { baseUrl: string; api: "openai-completions"; models: ModelDefinitionConfig[] }
  > = {};
  for (const [id, p] of Object.entries(providers)) {
    providersCfg[id] = { baseUrl: p.baseUrl, api: "openai-completions" as const, models: p.models };
  }
  return {
    models: { providers: providersCfg },
    ...(primaryModel ? { agents: { defaults: { model: { primary: primaryModel } } } } : {}),
  };
}

describe("collectConfiguredModels", () => {
  it("collects models from all providers", () => {
    const cfg = makeConfig({
      openai: { baseUrl: "https://api.openai.com/v1", models: [makeModel("gpt-4o")] },
      custom: {
        baseUrl: "https://example.com/v1",
        models: [makeModel("llama3"), makeModel("mistral")],
      },
    });
    const models = collectConfiguredModels(cfg);
    expect(models).toHaveLength(3);
    expect(models.map((m) => m.modelKey)).toEqual([
      "openai/gpt-4o",
      "custom/llama3",
      "custom/mistral",
    ]);
  });

  it("returns empty array when no providers configured", () => {
    expect(collectConfiguredModels({})).toEqual([]);
  });
});

describe("findModelInConfig", () => {
  it("finds a model by provider and id", () => {
    const cfg = makeConfig({
      custom: { baseUrl: "https://example.com/v1", models: [makeModel("my-model")] },
    });
    const entry = findModelInConfig(cfg, "custom", "my-model");
    expect(entry).toBeDefined();
    expect(entry!.modelKey).toBe("custom/my-model");
    expect(entry!.modelIndex).toBe(0);
  });

  it("returns undefined for non-existent model", () => {
    const cfg = makeConfig({
      custom: { baseUrl: "https://example.com/v1", models: [makeModel("my-model")] },
    });
    expect(findModelInConfig(cfg, "custom", "other")).toBeUndefined();
    expect(findModelInConfig(cfg, "unknown", "my-model")).toBeUndefined();
  });
});

describe("findPrimaryModelEntry", () => {
  it("finds the primary model entry", () => {
    const cfg = makeConfig(
      { thegrid: { baseUrl: "https://api.thegrid.ai/v1", models: [makeModel("text-prime")] } },
      "thegrid/text-prime",
    );
    const entry = findPrimaryModelEntry(cfg);
    expect(entry).toBeDefined();
    expect(entry!.modelKey).toBe("thegrid/text-prime");
  });

  it("returns undefined when no primary model set", () => {
    const cfg = makeConfig({
      custom: { baseUrl: "https://example.com/v1", models: [makeModel("m1")] },
    });
    expect(findPrimaryModelEntry(cfg)).toBeUndefined();
  });

  it("returns undefined when primary model not in providers", () => {
    const cfg = makeConfig(
      { custom: { baseUrl: "https://example.com/v1", models: [makeModel("m1")] } },
      "other/missing",
    );
    expect(findPrimaryModelEntry(cfg)).toBeUndefined();
  });
});

describe("applyModelDefinitionUpdate", () => {
  it("updates the model at the correct index", () => {
    const cfg = makeConfig({
      custom: {
        baseUrl: "https://example.com/v1",
        models: [makeModel("m1"), makeModel("m2", { contextWindow: 32_000 })],
      },
    });
    const entry = findModelInConfig(cfg, "custom", "m2")!;
    const updated = { ...entry.model, contextWindow: 256_000, maxTokens: 16_384 };
    const result = applyModelDefinitionUpdate(cfg, entry, updated);

    expect(result.models?.providers?.custom?.models?.[0]?.id).toBe("m1");
    expect(result.models?.providers?.custom?.models?.[1]?.contextWindow).toBe(256_000);
    expect(result.models?.providers?.custom?.models?.[1]?.maxTokens).toBe(16_384);
  });

  it("returns config unchanged if provider not found", () => {
    const cfg = makeConfig({
      custom: { baseUrl: "https://example.com/v1", models: [makeModel("m1")] },
    });
    const fakeEntry = {
      provider: "nonexistent",
      modelIndex: 0,
      model: makeModel("m1"),
      modelKey: "nonexistent/m1",
    };
    expect(applyModelDefinitionUpdate(cfg, fakeEntry, makeModel("m1"))).toBe(cfg);
  });
});

describe("formatTokenCount", () => {
  it("formats large numbers with k suffix", () => {
    expect(formatTokenCount(128_000)).toBe("128k");
    expect(formatTokenCount(200_000)).toBe("200k");
  });

  it("formats small numbers as-is", () => {
    expect(formatTokenCount(500)).toBe("500");
  });

  it("returns empty string for undefined/zero", () => {
    expect(formatTokenCount(undefined)).toBe("");
    expect(formatTokenCount(0)).toBe("");
  });
});

describe("promptModelMetadata", () => {
  it("prompts for all fields and returns metadata", async () => {
    const textResponses: Record<string, string> = {
      "Display name": "Test Model",
      "Context window (tokens)": "128000",
      "Max output tokens": "4096",
    };
    let confirmCall = 0;
    const confirmResponses = [
      true, // reasoning
      false, // configure cost
    ];

    const prompter = createWizardPrompter({
      text: vi.fn(async (params: { message: string; initialValue?: string }) => {
        return textResponses[params.message] ?? params.initialValue ?? "";
      }) as unknown as WizardPrompter["text"],
      select: vi.fn(async () => "__auto" as never),
      confirm: vi.fn(async () => confirmResponses[confirmCall++] ?? false),
      multiselect: vi.fn(async () => ["text", "image"]) as unknown as WizardPrompter["multiselect"],
    });

    const result = await promptModelMetadata(prompter);

    expect(result.id).toBeUndefined();
    expect(result.name).toBe("Test Model");
    expect(result.reasoning).toBe(true);
    expect(result.input).toEqual(["text", "image"]);
    expect(result.contextWindow).toBe(128_000);
    expect(result.maxTokens).toBe(4096);
    expect(result.api).toBeUndefined();
    expect(result.cost).toBeUndefined();
  });

  it("prefills with current values when editing", async () => {
    const current = makeModel("existing", {
      name: "Existing Model",
      contextWindow: 64_000,
      maxTokens: 2048,
      reasoning: true,
    });

    const capturedInitialValues: Record<string, string | undefined> = {};
    const prompter = createWizardPrompter({
      text: vi.fn(async (params: { message: string; initialValue?: string }) => {
        capturedInitialValues[params.message] = params.initialValue;
        return params.initialValue ?? "";
      }) as unknown as WizardPrompter["text"],
      select: vi.fn(async () => "__auto" as never),
      confirm: vi.fn(async (params: { initialValue?: boolean }) => params.initialValue ?? false),
      multiselect: vi.fn(async () => ["text"]) as unknown as WizardPrompter["multiselect"],
    });

    await promptModelMetadata(prompter, current);

    expect(capturedInitialValues["Display name"]).toBe("Existing Model");
    expect(capturedInitialValues["Context window (tokens)"]).toBe("64000");
    expect(capturedInitialValues["Max output tokens"]).toBe("2048");
  });
});

describe("promptModelMetadataForPrimary", () => {
  it("prompts for metadata when user confirms", async () => {
    const cfg = makeConfig(
      {
        custom: {
          baseUrl: "https://example.com/v1",
          models: [makeModel("m1", { contextWindow: 16_000 })],
        },
      },
      "custom/m1",
    );

    let confirmCall = 0;
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => {
        if (confirmCall++ === 0) {
          return true;
        } // yes, configure metadata
        return false; // no to reasoning, cost
      }),
      text: vi.fn(async (params: { message: string; initialValue?: string }) => {
        if (params.message === "Context window (tokens)") {
          return "200000";
        }
        if (params.message === "Max output tokens") {
          return "8192";
        }
        return params.initialValue ?? "";
      }) as unknown as WizardPrompter["text"],
      select: vi.fn(async () => "__auto" as never),
      multiselect: vi.fn(async () => ["text"]) as unknown as WizardPrompter["multiselect"],
    });

    const result = await promptModelMetadataForPrimary(cfg, prompter);

    expect(result.models?.providers?.custom?.models?.[0]?.contextWindow).toBe(200_000);
    expect(result.models?.providers?.custom?.models?.[0]?.maxTokens).toBe(8192);
  });

  it("skips when user declines", async () => {
    const cfg = makeConfig(
      { custom: { baseUrl: "https://example.com/v1", models: [makeModel("m1")] } },
      "custom/m1",
    );

    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => false),
    });

    const result = await promptModelMetadataForPrimary(cfg, prompter);
    expect(result).toBe(cfg);
  });

  it("returns config unchanged when no primary model", async () => {
    const cfg = makeConfig({
      custom: { baseUrl: "https://example.com/v1", models: [makeModel("m1")] },
    });
    const prompter = createWizardPrompter({});
    const result = await promptModelMetadataForPrimary(cfg, prompter);
    expect(result).toBe(cfg);
  });

  it("skips silently when primary model not in providers (built-in)", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o" } } },
    };
    const prompter = createWizardPrompter({});
    const result = await promptModelMetadataForPrimary(cfg, prompter);
    expect(result).toBe(cfg);
  });
});
