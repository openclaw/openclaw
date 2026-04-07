import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { listSessionsFromStore } from "./session-utils.js";

function createModelDefaultsConfig(params: {
  primary: string;
  models?: Record<string, Record<string, never>>;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: params.primary },
        models: params.models,
      },
    },
  } as OpenClawConfig;
}

function createLegacyRuntimeListConfig(
  models?: Record<string, Record<string, never>>,
): OpenClawConfig {
  return createModelDefaultsConfig({
    primary: "google-gemini-cli/gemini-3-pro-preview",
    ...(models ? { models } : {}),
  });
}

function createLegacyRuntimeStore(model: string): Record<string, SessionEntry> {
  return {
    "agent:main:main": {
      sessionId: "sess-main",
      updatedAt: Date.now(),
      model,
    } as SessionEntry,
  };
}

describe("listSessionsFromStore search", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  const baseCfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  } as OpenClawConfig;

  const makeStore = (): Record<string, SessionEntry> => ({
    "agent:main:work-project": {
      sessionId: "sess-work-1",
      updatedAt: Date.now(),
      displayName: "Work Project Alpha",
      label: "work",
    } as SessionEntry,
    "agent:main:personal-chat": {
      sessionId: "sess-personal-1",
      updatedAt: Date.now() - 1000,
      displayName: "Personal Chat",
      subject: "Family Reunion Planning",
    } as SessionEntry,
    "agent:main:discord:group:dev-team": {
      sessionId: "sess-discord-1",
      updatedAt: Date.now() - 2000,
      label: "discord",
      subject: "Dev Team Discussion",
    } as SessionEntry,
  });

  test("returns all sessions when search is empty or missing", () => {
    const cases = [{ opts: { search: "" } }, { opts: {} }] as const;
    for (const testCase of cases) {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        storePath: "/tmp/sessions.json",
        store: makeStore(),
        opts: testCase.opts,
      });
      expect(result.sessions).toHaveLength(3);
    }
  });

  test("filters sessions across display metadata and key fields", () => {
    const cases = [
      { search: "WORK PROJECT", expectedKey: "agent:main:work-project" },
      { search: "reunion", expectedKey: "agent:main:personal-chat" },
      { search: "discord", expectedKey: "agent:main:discord:group:dev-team" },
      { search: "sess-personal", expectedKey: "agent:main:personal-chat" },
      { search: "dev-team", expectedKey: "agent:main:discord:group:dev-team" },
      { search: "alpha", expectedKey: "agent:main:work-project" },
      { search: "  personal  ", expectedKey: "agent:main:personal-chat" },
      { search: "nonexistent-term", expectedKey: undefined },
    ] as const;

    for (const testCase of cases) {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        storePath: "/tmp/sessions.json",
        store: makeStore(),
        opts: { search: testCase.search },
      });
      if (!testCase.expectedKey) {
        expect(result.sessions).toHaveLength(0);
        continue;
      }
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].key).toBe(testCase.expectedKey);
    }
  });

  test("hides cron run alias session keys from sessions list", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:job-1": {
        sessionId: "run-abc",
        updatedAt: now,
        label: "Cron: job-1",
      } as SessionEntry,
      "agent:main:cron:job-1:run:run-abc": {
        sessionId: "run-abc",
        updatedAt: now,
        label: "Cron: job-1",
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["agent:main:cron:job-1"]);
  });

  test.each([
    {
      name: "does not guess provider for legacy runtime model without modelProvider",
      cfg: createLegacyRuntimeListConfig(),
      runtimeModel: "claude-sonnet-4-6",
      expectedProvider: undefined,
    },
    {
      name: "infers provider for legacy runtime model when allowlist match is unique",
      cfg: createLegacyRuntimeListConfig({ "anthropic/claude-sonnet-4-6": {} }),
      runtimeModel: "claude-sonnet-4-6",
      expectedProvider: "anthropic",
    },
    {
      name: "infers wrapper provider for slash-prefixed legacy runtime model when allowlist match is unique",
      cfg: createLegacyRuntimeListConfig({
        "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
      }),
      runtimeModel: "anthropic/claude-sonnet-4-6",
      expectedProvider: "vercel-ai-gateway",
    },
  ])("$name", ({ cfg, runtimeModel, expectedProvider }) => {
    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: createLegacyRuntimeStore(runtimeModel),
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe(expectedProvider);
    expect(result.sessions[0]?.model).toBe(runtimeModel);
  });

  test("exposes unknown totals when freshness is stale or missing", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:fresh": {
        sessionId: "sess-fresh",
        updatedAt: now,
        totalTokens: 1200,
        totalTokensFresh: true,
      } as SessionEntry,
      "agent:main:stale": {
        sessionId: "sess-stale",
        updatedAt: now - 1000,
        totalTokens: 2200,
        totalTokensFresh: false,
      } as SessionEntry,
      "agent:main:missing": {
        sessionId: "sess-missing",
        updatedAt: now - 2000,
        inputTokens: 100,
        outputTokens: 200,
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const fresh = result.sessions.find((row) => row.key === "agent:main:fresh");
    const stale = result.sessions.find((row) => row.key === "agent:main:stale");
    const missing = result.sessions.find((row) => row.key === "agent:main:missing");
    expect(fresh?.totalTokens).toBe(1200);
    expect(fresh?.totalTokensFresh).toBe(true);
    expect(stale?.totalTokens).toBeUndefined();
    expect(stale?.totalTokensFresh).toBe(false);
    expect(missing?.totalTokens).toBeUndefined();
    expect(missing?.totalTokensFresh).toBe(false);
  });

  test("includes estimated session cost when model pricing is configured", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.4",
                label: "GPT 5.4",
                baseUrl: "https://api.openai.com/v1",
                cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0.5 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.4",
          inputTokens: 2_000,
          outputTokens: 500,
          cacheRead: 1_000,
          cacheWrite: 200,
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.estimatedCostUsd).toBeCloseTo(0.007725, 8);
  });

  test("prefers persisted estimated session cost from the store", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-store-cost-"));
    const storePath = path.join(tmpDir, "sessions.json");
    fs.writeFileSync(
      path.join(tmpDir, "sess-main.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: 2_000,
              output: 500,
              cacheRead: 1_200,
              cost: { total: 0.007725 },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    try {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        storePath,
        store: {
          "agent:main:main": {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            modelProvider: "anthropic",
            model: "claude-sonnet-4-6",
            estimatedCostUsd: 0.1234,
            totalTokens: 0,
            totalTokensFresh: false,
          } as SessionEntry,
        },
        opts: {},
      });

      expect(result.sessions[0]?.estimatedCostUsd).toBe(0.1234);
      expect(result.sessions[0]?.totalTokens).toBe(3_200);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("keeps zero estimated session cost when configured model pricing resolves to free", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
      models: {
        providers: {
          "openai-codex": {
            models: [
              {
                id: "gpt-5.3-codex-spark",
                label: "GPT 5.3 Codex Spark",
                baseUrl: "https://api.openai.com/v1",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          inputTokens: 5_107,
          outputTokens: 1_827,
          cacheRead: 1_536,
          cacheWrite: 0,
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.estimatedCostUsd).toBe(0);
  });

  test("falls back to transcript usage for totalTokens and zero estimatedCostUsd", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-zero-cost-"));
    const storePath = path.join(tmpDir, "sessions.json");
    fs.writeFileSync(
      path.join(tmpDir, "sess-main.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.3-codex-spark",
            usage: {
              input: 5_107,
              output: 1_827,
              cacheRead: 1_536,
              cost: { total: 0 },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    try {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        storePath,
        store: {
          "agent:main:main": {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            modelProvider: "openai-codex",
            model: "gpt-5.3-codex-spark",
            totalTokens: 0,
            totalTokensFresh: false,
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
          } as SessionEntry,
        },
        opts: {},
      });

      expect(result.sessions[0]?.totalTokens).toBe(6_643);
      expect(result.sessions[0]?.totalTokensFresh).toBe(true);
      expect(result.sessions[0]?.estimatedCostUsd).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("falls back to transcript usage for totalTokens and estimatedCostUsd, and derives contextTokens from the resolved model", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
          },
        },
      },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-main.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: 2_000,
              output: 500,
              cacheRead: 1_200,
              cost: { total: 0.007725 },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    try {
      const result = listSessionsFromStore({
        cfg,
        storePath,
        store: {
          "agent:main:main": {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            modelProvider: "anthropic",
            model: "claude-sonnet-4-6",
            totalTokens: 0,
            totalTokensFresh: false,
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
          } as SessionEntry,
        },
        opts: {},
      });

      expect(result.sessions[0]?.totalTokens).toBe(3_200);
      expect(result.sessions[0]?.totalTokensFresh).toBe(true);
      expect(result.sessions[0]?.contextTokens).toBe(1_048_576);
      expect(result.sessions[0]?.estimatedCostUsd).toBeCloseTo(0.007725, 8);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("uses subagent run model immediately for child sessions while transcript usage fills live totals", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-subagent-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const now = Date.now();
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
          },
        },
      },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-child.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-child" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: 2_000,
              output: 500,
              cacheRead: 1_200,
              cost: { total: 0.007725 },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    addSubagentRunForTests({
      runId: "run-child-live",
      childSessionKey: "agent:main:subagent:child-live",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "child task",
      cleanup: "keep",
      createdAt: now - 5_000,
      startedAt: now - 4_000,
      model: "anthropic/claude-sonnet-4-6",
    });

    try {
      const result = listSessionsFromStore({
        cfg,
        storePath,
        store: {
          "agent:main:subagent:child-live": {
            sessionId: "sess-child",
            updatedAt: now,
            spawnedBy: "agent:main:main",
            totalTokens: 0,
            totalTokensFresh: false,
          } as SessionEntry,
        },
        opts: {},
      });

      expect(result.sessions[0]).toMatchObject({
        key: "agent:main:subagent:child-live",
        status: "running",
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        totalTokens: 3_200,
        totalTokensFresh: true,
        contextTokens: 1_048_576,
      });
      expect(result.sessions[0]?.estimatedCostUsd).toBeCloseTo(0.007725, 8);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("keeps a running subagent model when transcript fallback still reflects an older run", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-session-utils-subagent-stale-model-"),
    );
    const storePath = path.join(tmpDir, "sessions.json");
    const now = Date.now();
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
          },
        },
      },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-child-stale.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-child-stale" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: 2_000,
              output: 500,
              cacheRead: 1_200,
              cost: { total: 0.007725 },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    addSubagentRunForTests({
      runId: "run-child-live-new-model",
      childSessionKey: "agent:main:subagent:child-live-stale-transcript",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "child task",
      cleanup: "keep",
      createdAt: now - 5_000,
      startedAt: now - 4_000,
      model: "openai/gpt-5.4",
    });

    try {
      const result = listSessionsFromStore({
        cfg,
        storePath,
        store: {
          "agent:main:subagent:child-live-stale-transcript": {
            sessionId: "sess-child-stale",
            updatedAt: now,
            spawnedBy: "agent:main:main",
            totalTokens: 0,
            totalTokensFresh: false,
          } as SessionEntry,
        },
        opts: {},
      });

      expect(result.sessions[0]).toMatchObject({
        key: "agent:main:subagent:child-live-stale-transcript",
        status: "running",
        modelProvider: "openai",
        model: "gpt-5.4",
        totalTokens: 3_200,
        totalTokensFresh: true,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("keeps the selected override model when runtime identity was intentionally cleared", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-session-utils-cleared-runtime-model-"),
    );
    const storePath = path.join(tmpDir, "sessions.json");
    const now = Date.now();
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
          },
        },
      },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-override.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-override" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: 2_000,
              output: 500,
              cacheRead: 1_200,
              cost: { total: 0.007725 },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    try {
      const result = listSessionsFromStore({
        cfg,
        storePath,
        store: {
          "agent:main:main": {
            sessionId: "sess-override",
            updatedAt: now,
            providerOverride: "openai",
            modelOverride: "gpt-5.4",
            totalTokens: 0,
            totalTokensFresh: false,
          } as SessionEntry,
        },
        opts: {},
      });

      expect(result.sessions[0]).toMatchObject({
        key: "agent:main:main",
        modelProvider: "openai",
        model: "gpt-5.4",
        totalTokens: 3_200,
        totalTokensFresh: true,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("does not replace the current runtime model when transcript fallback is only for missing pricing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-pricing-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const now = Date.now();
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true }],
      },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-pricing.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-pricing" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: 2_000,
              output: 500,
              cacheRead: 1_200,
              cost: { total: 0.007725 },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    try {
      const result = listSessionsFromStore({
        cfg,
        storePath,
        store: {
          "agent:main:main": {
            sessionId: "sess-pricing",
            updatedAt: now,
            modelProvider: "openai",
            model: "gpt-5.4",
            contextTokens: 200_000,
            totalTokens: 3_200,
            totalTokensFresh: true,
            inputTokens: 2_000,
            outputTokens: 500,
            cacheRead: 1_200,
          } as SessionEntry,
        },
        opts: {},
      });

      expect(result.sessions[0]).toMatchObject({
        key: "agent:main:main",
        modelProvider: "openai",
        model: "gpt-5.4",
        totalTokens: 3_200,
        totalTokensFresh: true,
        contextTokens: 200_000,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
