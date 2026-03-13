import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyVllmDefaultModel, clearStaleVllmDefaultModel } from "./vllm-default-model.js";

describe("clearStaleVllmDefaultModel", () => {
  it("skips removed managed vLLM fallbacks before promoting a new primary", () => {
    const next = clearStaleVllmDefaultModel({
      agents: {
        defaults: {
          model: {
            primary: "vllm/model-a",
            fallbacks: ["vllm-2/model-b", "anthropic/claude-sonnet-4-5", "vllm-3/model-c"],
          },
        },
      },
      models: {
        providers: {},
      },
    } satisfies OpenClawConfig);

    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-sonnet-4-5",
    });
  });

  it("keeps managed vLLM fallbacks that still exist", () => {
    const next = clearStaleVllmDefaultModel({
      agents: {
        defaults: {
          model: {
            primary: "vllm/model-a",
            fallbacks: ["vllm-2/model-b", "anthropic/claude-sonnet-4-5"],
          },
        },
      },
      models: {
        providers: {
          "vllm-2": {
            baseUrl: "http://localhost:8001/v1",
            apiKey: "unused",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig);

    expect(next.agents?.defaults?.model).toEqual({
      primary: "vllm-2/model-b",
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
  });

  it("prunes stale managed vLLM fallbacks even when primary is non-vLLM", () => {
    const next = clearStaleVllmDefaultModel({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-5",
            fallbacks: ["vllm/model-a", "vllm-2/model-b", "openai/gpt-5.3-codex"],
          },
        },
      },
      models: {
        providers: {},
      },
    } satisfies OpenClawConfig);

    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-sonnet-4-5",
      fallbacks: ["openai/gpt-5.3-codex"],
    });
  });

  it("keeps differently cased managed provider keys when checking for stale refs", () => {
    const next = clearStaleVllmDefaultModel({
      agents: {
        defaults: {
          model: {
            primary: "vllm/model-a",
            fallbacks: ["anthropic/claude-sonnet-4-5"],
          },
        },
      },
      models: {
        providers: {
          VLLM: {
            baseUrl: "http://localhost:8000/v1",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig);

    expect(next.agents?.defaults?.model).toEqual({
      primary: "vllm/model-a",
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
  });

  it("drops stale managed fallbacks when applying a new default model", () => {
    const next = applyVllmDefaultModel(
      {
        agents: {
          defaults: {
            model: {
              primary: "vllm/model-a",
              fallbacks: ["vllm-2/model-b", "anthropic/claude-sonnet-4-5"],
            },
          },
        },
        models: {
          providers: {
            vllm: {
              baseUrl: "http://localhost:8000/v1",
              models: [],
            },
          },
        },
      } satisfies OpenClawConfig,
      "vllm/model-c",
    );

    expect(next.agents?.defaults?.model).toEqual({
      primary: "vllm/model-c",
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
  });
});
