import { describe, expect, it } from "vitest";
import { resolvePersistCandidateForWrite } from "./io.write-prepare.js";

type PersistInput = Parameters<typeof resolvePersistCandidateForWrite>[0];

describe("config io write prepare / include write-through", () => {
  it("rejects flattening an include-owned provider catalog without write-through", () => {
    const currentModels = [{ id: "llama3", name: "llama3" }];
    const nextModels = [
      { id: "llama3", name: "llama3" },
      { id: "qwen3", name: "qwen3" },
    ];
    const current = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: currentModels,
          },
        },
      },
      agents: { defaults: { models: { "openai/gpt-5.6-sol": {} } } },
    };

    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: current,
        sourceConfig: current,
        rootAuthoredConfig: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://127.0.0.1:11434",
                api: "ollama",
                models: { $include: "./config/models/ollama.json5" },
              },
            },
          },
          agents: { defaults: { models: { "openai/gpt-5.6-sol": {} } } },
        },
        nextConfig: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://127.0.0.1:11434",
                api: "ollama",
                apiKey: "ollama-local",
                models: nextModels,
              },
            },
          },
          agents: {
            defaults: {
              models: { "openai/gpt-5.6-sol": {}, "ollama/llama3": {}, "ollama/qwen3": {} },
            },
          },
        },
      }),
    ).toThrow("Config write would flatten $include-owned config at models.providers.ollama.models");
  });

  it("rejects dropping an include-owned section while a sibling include remains", () => {
    const pendingIncludeWrites: NonNullable<PersistInput["pendingIncludeWrites"]> = [];
    const current = {
      agents: {
        defaults: { workspace: "/srv/old" },
        entries: { ops: { default: true } },
      },
      gateway: { mode: "local" },
    };

    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: current,
        sourceConfig: current,
        rootAuthoredConfig: {
          agents: { $include: "./agents.json5" },
          gateway: { $include: "./gateway.json5" },
        },
        nextConfig: { agents: current.agents },
        pendingIncludeWrites,
      }),
    ).toThrow("Config write would flatten $include-owned config at gateway");
    expect(pendingIncludeWrites).toEqual([]);
  });
});
