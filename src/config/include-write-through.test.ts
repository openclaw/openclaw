// Relocated from io.write-prepare.test.ts (base b45488b243b03defb97422338166d9d1b3ba6b6c):
// collectIncludeOwnedPaths-driven include write-through path collection and
// flatten-rejection cases for resolvePersistCandidateForWrite.
import { describe, expect, it } from "vitest";
import { resolvePersistCandidateForWrite } from "./io.write-prepare.js";

type PersistInput = Parameters<typeof resolvePersistCandidateForWrite>[0];

const roster = (entries: Record<string, unknown>) => ({ agents: { entries } });

describe("config io write prepare / include write-through", () => {
  it("collects sole-owner keyed agent entry writes instead of flattening the roster", () => {
    const pendingIncludeWrites: NonNullable<PersistInput["pendingIncludeWrites"]> = [];
    const authored = {
      agents: { entries: { tony: { $include: "./tony.json5" } } },
    };
    const current = roster({ tony: { model: { primary: "claude-cli/claude-opus-4-8" } } });
    const next = roster({ tony: { model: { primary: "anthropic/claude-opus-4-8" } } });

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: current,
      sourceConfig: current,
      rootAuthoredConfig: authored,
      nextConfig: next,
      pendingIncludeWrites,
    });

    expect(persisted).toEqual(authored);
    expect(pendingIncludeWrites).toEqual([
      {
        includePath: ["agents", "entries", "tony"],
        value: { model: { primary: "anthropic/claude-opus-4-8" } },
      },
    ]);
  });

  it("adds a sibling agent beside include-owned entries without flattening them", () => {
    const pendingIncludeWrites: NonNullable<PersistInput["pendingIncludeWrites"]> = [];
    const authored = {
      agents: { entries: { tony: { $include: "./tony.json5" } } },
    };
    const current = roster({ tony: { workspace: "/w/tony" } });
    const next = roster({
      tony: { workspace: "/w/tony" },
      worker: { workspace: "/w/worker" },
    });

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: current,
      sourceConfig: current,
      rootAuthoredConfig: authored,
      nextConfig: next,
      pendingIncludeWrites,
    });

    expect(persisted).toEqual({
      agents: {
        entries: {
          tony: { $include: "./tony.json5" },
          worker: { workspace: "/w/worker" },
        },
      },
    });
    expect(pendingIncludeWrites).toEqual([]);
  });

  it("writes through a changed include-owned entry while adding a sibling", () => {
    const pendingIncludeWrites: NonNullable<PersistInput["pendingIncludeWrites"]> = [];
    const authored = {
      agents: { entries: { tony: { $include: "./tony.json5" } } },
    };
    const current = roster({ tony: { workspace: "/w/tony" } });
    const next = roster({
      tony: { workspace: "/w/tony-next" },
      worker: { workspace: "/w/worker" },
    });

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: current,
      sourceConfig: current,
      rootAuthoredConfig: authored,
      nextConfig: next,
      pendingIncludeWrites,
    });

    expect(persisted).toEqual({
      agents: {
        entries: {
          tony: { $include: "./tony.json5" },
          worker: { workspace: "/w/worker" },
        },
      },
    });
    expect(pendingIncludeWrites).toEqual([
      {
        includePath: ["agents", "entries", "tony"],
        value: { workspace: "/w/tony-next" },
      },
    ]);
  });

  it("collects mixed root auth and include-owned system-agent model writes", () => {
    const pendingIncludeWrites: NonNullable<PersistInput["pendingIncludeWrites"]> = [];
    const authored = {
      wizard: { lastRunCommand: "configure" },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "reverend-run" } },
        entries: { "reverend-run": { $include: "./reverend-run.json5" } },
      },
    };
    const current = {
      wizard: { lastRunCommand: "configure" },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "reverend-run" } },
        entries: { "reverend-run": { model: { primary: "openai/gpt-5.5" } } },
      },
    };
    const next = {
      wizard: { lastRunCommand: "models" },
      auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
      agents: {
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: "reverend-run" },
          models: { "openai/gpt-5.6-sol": {} },
        },
        entries: { "reverend-run": { model: { primary: "openai/gpt-5.6-sol" } } },
      },
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: current,
      sourceConfig: current,
      rootAuthoredConfig: authored,
      nextConfig: next,
      pendingIncludeWrites,
    });

    expect(persisted).toEqual({
      wizard: { lastRunCommand: "models" },
      auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
      agents: {
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: "reverend-run" },
          models: { "openai/gpt-5.6-sol": {} },
        },
        entries: { "reverend-run": { $include: "./reverend-run.json5" } },
      },
    });
    expect(pendingIncludeWrites).toEqual([
      {
        includePath: ["agents", "entries", "reverend-run"],
        value: { model: { primary: "openai/gpt-5.6-sol" } },
      },
    ]);
  });

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

  it("collects mixed root allowlist and include-owned provider catalog writes", () => {
    const pendingIncludeWrites: NonNullable<PersistInput["pendingIncludeWrites"]> = [];
    const currentModels = [{ id: "llama3", name: "llama3" }];
    const nextModels = [
      { id: "llama3", name: "llama3" },
      { id: "qwen3", name: "qwen3" },
    ];
    const authored = {
      wizard: { lastRunCommand: "configure" },
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
    };
    const current = {
      wizard: { lastRunCommand: "configure" },
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
    const next = {
      wizard: { lastRunCommand: "configure" },
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
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: current,
      sourceConfig: current,
      rootAuthoredConfig: authored,
      nextConfig: next,
      pendingIncludeWrites,
      explicitSetPaths: [
        ["models", "providers", "ollama", "apiKey"],
        ["models", "providers", "ollama", "models"],
        ["agents", "defaults", "models", "openai/gpt-5.6-sol"],
        ["agents", "defaults", "models", "ollama/llama3"],
        ["agents", "defaults", "models", "ollama/qwen3"],
      ],
    });

    expect(persisted).toEqual({
      wizard: { lastRunCommand: "configure" },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            apiKey: "ollama-local",
            models: { $include: "./config/models/ollama.json5" },
          },
        },
      },
      agents: {
        defaults: {
          models: { "openai/gpt-5.6-sol": {}, "ollama/llama3": {}, "ollama/qwen3": {} },
        },
      },
    });
    expect(pendingIncludeWrites).toEqual([
      {
        includePath: ["models", "providers", "ollama", "models"],
        value: nextModels,
      },
    ]);
  });

  it("collects mixed root allowlist, include-owned agent, and include-owned provider catalog writes", () => {
    const pendingIncludeWrites: NonNullable<PersistInput["pendingIncludeWrites"]> = [];
    const currentModels = [{ id: "llama3", name: "llama3" }];
    const nextModels = [
      { id: "llama3", name: "llama3" },
      { id: "qwen3", name: "qwen3" },
    ];
    const authored = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: { $include: "./config/models/ollama.json5" },
          },
        },
      },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "reverend-run" } },
        entries: { "reverend-run": { $include: "./reverend-run.json5" } },
      },
    };
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
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "reverend-run" } },
        entries: { "reverend-run": { model: { primary: "openai/gpt-5.6-sol" } } },
      },
    };
    const next = {
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
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: "reverend-run" },
          models: { "openai/gpt-5.6-sol": {}, "ollama/llama3": {} },
        },
        entries: { "reverend-run": { model: { primary: "ollama/llama3" } } },
      },
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: current,
      sourceConfig: current,
      rootAuthoredConfig: authored,
      nextConfig: next,
      pendingIncludeWrites,
      explicitSetPaths: [
        ["models", "providers", "ollama", "apiKey"],
        ["models", "providers", "ollama", "models"],
        ["agents", "defaults", "models", "openai/gpt-5.6-sol"],
        ["agents", "defaults", "models", "ollama/llama3"],
        ["agents", "entries", "reverend-run", "model", "primary"],
      ],
    });

    expect(persisted).toEqual({
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            apiKey: "ollama-local",
            models: { $include: "./config/models/ollama.json5" },
          },
        },
      },
      agents: {
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: "reverend-run" },
          models: { "openai/gpt-5.6-sol": {}, "ollama/llama3": {} },
        },
        entries: { "reverend-run": { $include: "./reverend-run.json5" } },
      },
    });
    expect(pendingIncludeWrites).toEqual([
      {
        includePath: ["agents", "entries", "reverend-run"],
        value: { model: { primary: "ollama/llama3" } },
      },
      {
        includePath: ["models", "providers", "ollama", "models"],
        value: nextModels,
      },
    ]);
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
