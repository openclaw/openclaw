import { describe, expect, it } from "vitest";
import { addConfiguredAgentRuntimeMetadata } from "./models-list-runtime-metadata.js";

describe("models-list-result runtime metadata", () => {
  it("exposes configured Codex runtime metadata for model picker choices", () => {
    const models = addConfiguredAgentRuntimeMetadata({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        },
      } as never,
      agentId: "main",
      catalog: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          provider: "openai",
        },
      ],
    });

    expect(models).toEqual([
      {
        id: "gpt-5.5",
        name: "gpt-5.5",
        provider: "openai",
        agentRuntime: {
          id: "codex",
          label: "OpenAI Codex",
          source: "model",
        },
      },
    ]);
  });

  it("omits implicit runtime metadata to keep legacy picker payloads compact", () => {
    const models = addConfiguredAgentRuntimeMetadata({
      cfg: {} as never,
      agentId: "main",
      catalog: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          provider: "openai",
        },
      ],
    });

    expect(models).toEqual([
      {
        id: "gpt-5.5",
        name: "gpt-5.5",
        provider: "openai",
      },
    ]);
  });
});
