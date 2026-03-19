import { describe, expect, it } from "vitest";
import { SYNTHETIC_DEFAULT_MODEL_ID } from "../agents/synthetic-models.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  applyModelStudioProviderConfig,
  applySyntheticProviderConfig,
  applyZaiProviderConfig,
} from "./onboard-auth.config-core.js";
import { applyMinimaxApiConfig, applyMinimaxApiConfigCn } from "./onboard-auth.config-minimax.js";

function makeModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}

describe("core onboarding provider rewriters", () => {
  const secretRef = {
    source: "env" as const,
    provider: "default",
    id: "TEST_API_KEY",
  };

  it("rewrites aliased ZAI providers to the canonical key and preserves secret refs", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "z-ai": {
            api: "openai-completions",
            baseUrl: "https://zai-preview.example/v1",
            apiKey: secretRef,
            models: [makeModel("legacy-zai-model")],
          },
        },
      },
    };

    const result = applyZaiProviderConfig(cfg);

    expect(Object.keys(result.models?.providers ?? {})).toEqual(["zai"]);
    expect(result.models?.providers?.zai?.baseUrl).toBe("https://zai-preview.example/v1");
    expect(result.models?.providers?.zai?.apiKey).toEqual(secretRef);
    expect(result.models?.providers?.zai?.models?.map((model) => model.id)).toEqual(
      expect.arrayContaining(["legacy-zai-model", "glm-5"]),
    );
  });

  it("preserves secret-ref api keys when rewriting Synthetic", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          synthetic: {
            api: "openai-completions",
            baseUrl: "https://synthetic-legacy.example/v1",
            apiKey: secretRef,
            models: [makeModel("legacy-synthetic-model")],
          },
        },
      },
    };

    const result = applySyntheticProviderConfig(cfg);

    expect(result.models?.providers?.synthetic?.apiKey).toEqual(secretRef);
    expect(result.models?.providers?.synthetic?.models?.map((model) => model.id)).toEqual(
      expect.arrayContaining(["legacy-synthetic-model", SYNTHETIC_DEFAULT_MODEL_ID]),
    );
  });

  it("preserves secret-ref api keys when rewriting Model Studio", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          modelstudio: {
            api: "openai-completions",
            baseUrl: "https://modelstudio-legacy.example/v1",
            apiKey: secretRef,
            models: [makeModel("legacy-modelstudio-model")],
          },
        },
      },
    };

    const result = applyModelStudioProviderConfig(cfg);

    expect(result.models?.providers?.modelstudio?.apiKey).toEqual(secretRef);
    expect(result.models?.providers?.modelstudio?.models?.map((model) => model.id)).toEqual(
      expect.arrayContaining(["legacy-modelstudio-model", "qwen3.5-plus"]),
    );
  });

  it("preserves secret-ref api keys when rewriting MiniMax global config", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          minimax: {
            api: "openai-completions",
            baseUrl: "https://minimax-legacy.example/anthropic",
            apiKey: secretRef,
            models: [makeModel("legacy-minimax-model")],
          },
        },
      },
    };

    const result = applyMinimaxApiConfig(cfg);

    expect(result.models?.providers?.minimax?.apiKey).toEqual(secretRef);
    expect(result.models?.providers?.minimax?.baseUrl).toBe("https://api.minimax.io/anthropic");
    expect(result.models?.providers?.minimax?.models?.map((model) => model.id)).toEqual(
      expect.arrayContaining(["legacy-minimax-model", "MiniMax-M2.5"]),
    );
  });

  it("preserves secret-ref api keys when rewriting MiniMax CN config", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          minimax: {
            api: "openai-completions",
            baseUrl: "https://minimax-legacy.example/anthropic",
            apiKey: secretRef,
            models: [makeModel("legacy-minimax-model")],
          },
        },
      },
    };

    const result = applyMinimaxApiConfigCn(cfg);

    expect(result.models?.providers?.minimax?.apiKey).toEqual(secretRef);
    expect(result.models?.providers?.minimax?.baseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(result.models?.providers?.minimax?.models?.map((model) => model.id)).toEqual(
      expect.arrayContaining(["legacy-minimax-model", "MiniMax-M2.5"]),
    );
  });
});
