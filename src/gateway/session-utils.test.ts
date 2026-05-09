import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  buildGatewaySessionRow,
  capArrayByJsonBytes,
  classifySessionKey,
  deriveSessionTitle,
  getSessionDefaults,
  listAgentsForGateway,
  listSessionsFromStore,
  listSessionsFromStoreAsync,
  parseGroupKey,
  resolveDeletedAgentIdFromSessionKey,
  resolveGatewayModelSupportsImages,
  resolveGatewaySessionDatabaseTarget,
  resolveSessionDisplayModelIdentityRef,
  resolveSessionModelIdentityRef,
  resolveSessionModelRef,
  resolveSessionRowKey,
} from "./session-utils.js";

function createSymlinkOrSkip(targetPath: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(targetPath, linkPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      return false;
    }
    throw error;
  }
}

function createSingleAgentAvatarConfig(workspace: string): OpenClawConfig {
  return {
    session: { mainKey: "main" },
    agents: {
      list: [{ id: "main", default: true, workspace, identity: { avatar: "avatar-link.png" } }],
    },
  } as OpenClawConfig;
}

function createModelDefaultsConfig(params: {
  primary: string;
  models?: Record<string, { agentRuntime?: { id: string } }>;
  agentRuntime?: { id: string };
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: params.primary },
        models: {
          ...params.models,
          ...(params.agentRuntime
            ? { [params.primary]: { agentRuntime: params.agentRuntime } }
            : {}),
        },
      },
    },
  } as OpenClawConfig;
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

describe("gateway session utils", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
  });

  test("capArrayByJsonBytes trims from the front", () => {
    const res = capArrayByJsonBytes(["a", "b", "c"], 10);
    expect(res.items).toEqual(["b", "c"]);
  });

  test("session lists apply a bounded default and expose truncation metadata", async () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    const store = Object.fromEntries(
      Array.from({ length: 101 }, (_value, index) => [
        `session-${index}`,
        {
          sessionId: `session-${index}`,
          updatedAt: 1_000 - index,
          modelProvider: "openai",
          model: "gpt-5.4",
        } satisfies SessionEntry,
      ]),
    );

    const listed = await listSessionsFromStoreAsync({
      cfg,
      store,
      opts: {},
    });

    expect(listed.sessions).toHaveLength(100);
    expect(listed.count).toBe(100);
    expect(listed.totalCount).toBe(101);
    expect(listed.limitApplied).toBe(100);
    expect(listed.hasMore).toBe(true);
    expect(listed.sessions[0]?.key).toBe("session-0");
    expect(listed.sessions.at(-1)?.key).toBe("session-99");
  });

  test("session lists honor explicit caller limits", () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    const store = Object.fromEntries(
      Array.from({ length: 5 }, (_value, index) => [
        `session-${index}`,
        {
          sessionId: `session-${index}`,
          updatedAt: 1_000 - index,
        } satisfies SessionEntry,
      ]),
    );

    const listed = listSessionsFromStore({
      cfg,
      store,
      opts: { limit: 3 },
    });

    expect(listed.sessions.map((session) => session.key)).toEqual([
      "session-0",
      "session-1",
      "session-2",
    ]);
    expect(listed.count).toBe(3);
    expect(listed.totalCount).toBe(5);
    expect(listed.limitApplied).toBe(3);
    expect(listed.hasMore).toBe(true);
  });

  test("parseGroupKey handles group keys", () => {
    expect(parseGroupKey("discord:group:dev")).toEqual({
      channel: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("agent:ops:discord:group:dev")).toEqual({
      channel: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("foo:bar")).toBeNull();
  });

  test("session defaults include provider-owned thinking options", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "test",
      source: "test",
      provider: {
        id: "openai-codex",
        label: "OpenAI Codex",
        auth: [],
        resolveThinkingProfile: ({ modelId }) => ({
          levels: [
            { id: "off" },
            { id: "minimal" },
            { id: "low" },
            { id: "medium" },
            { id: "adaptive" },
            { id: "high" },
            ...(modelId === "gpt-5.5" ? [{ id: "xhigh" as const }] : []),
            { id: "max", label: "maximum" },
          ],
          defaultLevel: "adaptive",
        }),
      },
    });
    setActivePluginRegistry(registry);

    const defaults = getSessionDefaults(
      createModelDefaultsConfig({ primary: "openai-codex/gpt-5.5" }),
    );

    expect(defaults).toMatchObject({
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      thinkingDefault: "adaptive",
    });
    expect(defaults.thinkingLevels).toEqual(
      expect.arrayContaining([
        { id: "adaptive", label: "adaptive" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "maximum" },
      ]),
    );
    expect(defaults.thinkingOptions).toEqual(
      expect.arrayContaining(["adaptive", "xhigh", "maximum"]),
    );
  });

  test("session defaults and rows use catalog reasoning metadata for provider thinking options", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "ollama",
      source: "test",
      provider: {
        id: "ollama",
        label: "Ollama",
        auth: [],
        resolveThinkingProfile: ({ reasoning }) => ({
          levels:
            reasoning === true
              ? [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }]
              : [{ id: "off" }],
          defaultLevel: reasoning === true ? "medium" : "off",
        }),
      },
    });
    setActivePluginRegistry(registry);

    const cfg = createModelDefaultsConfig({ primary: "ollama/qwen3:0.6b" });
    const catalog = [
      {
        provider: "ollama",
        id: "qwen3:0.6b",
        name: "qwen3:0.6b",
        reasoning: true,
      },
    ];

    const defaults = getSessionDefaults(cfg, catalog);
    const row = buildGatewaySessionRow({
      cfg,
      store: {},
      key: "main",
      modelCatalog: catalog,
    });

    expect(defaults.thinkingLevels?.map((level) => level.id)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(row.thinkingLevels?.map((level) => level.id)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(defaults.thinkingDefault).toBe("medium");
    expect(row.thinkingDefault).toBe("medium");
  });

  test("async session list reuses thinking metadata for lightweight rows", async () => {
    const resolveThinkingProfile = vi.fn(() => ({
      levels: [{ id: "off" as const }, { id: "medium" as const }],
      defaultLevel: "medium" as const,
    }));
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "test",
      source: "test",
      provider: {
        id: "openai-codex",
        label: "OpenAI Codex",
        auth: [],
        resolveThinkingProfile,
      },
    });
    setActivePluginRegistry(registry);

    const cfg = createModelDefaultsConfig({ primary: "openai-codex/gpt-5.5" });
    const store = Object.fromEntries(
      Array.from({ length: 5 }, (_value, index) => [
        `session-${index}`,
        {
          sessionId: `session-${index}`,
          modelProvider: "openai-codex",
          model: "gpt-5.5",
          updatedAt: Date.now() - index,
        } satisfies SessionEntry,
      ]),
    );

    const result = await listSessionsFromStoreAsync({
      cfg,
      store,
      opts: {},
    });

    expect(result.sessions).toHaveLength(5);
    const missingMediumLevelSessionIds = result.sessions
      .filter((session) => !session.thinkingLevels?.some((level) => level.id === "medium"))
      .map((session) => session.sessionId);
    const missingMediumOptionSessionIds = result.sessions
      .filter((session) => !session.thinkingOptions?.includes("medium"))
      .map((session) => session.sessionId);

    expect(missingMediumLevelSessionIds).toStrictEqual([]);
    expect(missingMediumOptionSessionIds).toStrictEqual([]);
    expect(result.sessions.map((session) => session.thinkingDefault)).toEqual(
      Array.from({ length: result.sessions.length }, () => "medium"),
    );
    expect(resolveThinkingProfile).toHaveBeenCalled();
  });

  test("session list thinking cache preserves case-distinct model catalog entries", () => {
    const cfg = createModelDefaultsConfig({ primary: "custom/CaseModel" });
    const modelCatalog = [
      {
        provider: "custom",
        id: "CaseModel",
        name: "CaseModel",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      },
      {
        provider: "custom",
        id: "casemodel",
        name: "casemodel",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
      },
    ];
    const result = listSessionsFromStore({
      cfg,
      modelCatalog,
      store: {
        upper: {
          sessionId: "upper",
          modelProvider: "custom",
          model: "CaseModel",
          updatedAt: 2,
        } satisfies SessionEntry,
        lower: {
          sessionId: "lower",
          modelProvider: "custom",
          model: "casemodel",
          updatedAt: 1,
        } satisfies SessionEntry,
      },
      opts: {},
    });

    const upper = result.sessions.find((session) => session.key === "upper");
    const lower = result.sessions.find((session) => session.key === "lower");
    expect(upper?.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
    expect(lower?.thinkingLevels?.map((level) => level.id)).not.toContain("xhigh");
  });

  test("session defaults and rows expose xhigh from configured catalog compat", () => {
    const cfg = createModelDefaultsConfig({ primary: "gmn/gpt-5.4" });
    const catalog = [
      {
        provider: "gmn",
        id: "gpt-5.4",
        name: "GPT 5.4 via GMN",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      },
    ];

    const defaults = getSessionDefaults(cfg, catalog);
    const row = buildGatewaySessionRow({
      cfg,
      store: {},
      key: "main",
      modelCatalog: catalog,
    });

    expect(defaults.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
    expect(row.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
  });

  test("session defaults and rows expose bundled startup-lazy provider thinking without catalog", () => {
    const cfg = createModelDefaultsConfig({ primary: "openai-codex/gpt-5.5" });

    const defaults = getSessionDefaults(cfg);
    const row = buildGatewaySessionRow({
      cfg,
      store: {},
      key: "main",
    });

    expect(defaults.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
    expect(row.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
  });

  test("session defaults use configured thinking default", () => {
    const defaults = getSessionDefaults({
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.5" },
          thinkingDefault: "high",
        },
      },
    } as OpenClawConfig);

    expect(defaults).toMatchObject({
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      thinkingDefault: "high",
    });
  });

  test("session rows use per-agent thinking default from config", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.5" },
          thinkingDefault: "low",
          models: {
            "openai-codex/gpt-5.5": {
              params: { thinking: "max" },
            },
          },
        },
        list: [
          {
            id: "alpha",
            default: true,
            thinkingDefault: "high",
          },
        ],
      },
    } as OpenClawConfig;

    const row = buildGatewaySessionRow({
      cfg,
      store: {},
      key: "agent:alpha:main",
    });

    expect(row).toMatchObject({
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      thinkingDefault: "high",
    });
  });

  test("session rows prefer per-model thinking over global default", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.5" },
          thinkingDefault: "low",
          models: {
            "openai-codex/gpt-5.5": {
              params: { thinking: "max" },
            },
          },
        },
      },
    } as OpenClawConfig;

    const row = buildGatewaySessionRow({
      cfg,
      store: {},
      key: "main",
    });

    expect(row).toMatchObject({
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      thinkingDefault: "max",
    });
  });

  test("classifySessionKey respects chat type + prefixes", () => {
    expect(classifySessionKey("global")).toBe("global");
    expect(classifySessionKey("unknown")).toBe("unknown");
    expect(classifySessionKey("discord:group:dev")).toBe("group");
    expect(classifySessionKey("main")).toBe("direct");
    const entry = { chatType: "group" } as SessionEntry;
    expect(classifySessionKey("main", entry)).toBe("group");
  });

  test("resolveSessionRowKey maps only current-agent main aliases to default agent main", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionRowKey({ cfg, sessionKey: "main" })).toBe("agent:ops:work");
    expect(resolveSessionRowKey({ cfg, sessionKey: "work" })).toBe("agent:ops:work");
    expect(resolveSessionRowKey({ cfg, sessionKey: "agent:ops:main" })).toBe("agent:ops:work");
    expect(resolveSessionRowKey({ cfg, sessionKey: "agent:ops:MAIN" })).toBe("agent:ops:work");
    expect(resolveSessionRowKey({ cfg, sessionKey: "agent:main:main" })).toBe("agent:main:work");
    expect(resolveSessionRowKey({ cfg, sessionKey: "agent:main:work" })).toBe("agent:main:work");
    expect(resolveSessionRowKey({ cfg, sessionKey: "MAIN" })).toBe("agent:ops:work");
  });

  test("resolveSessionRowKey preserves non-alias agent:main keys for deleted-agent checks", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionRowKey({ cfg, sessionKey: "agent:main:discord:direct:u1" })).toBe(
      "agent:main:discord:direct:u1",
    );
  });

  test("resolveDeletedAgentIdFromSessionKey rejects main-agent keys when main is absent", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "global")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "unknown")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "main")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "agent:main:main")).toBe("main");
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "agent:main:discord:direct:u1")).toBe("main");
  });

  test("resolveSessionRowKey canonicalizes bare keys to default agent", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionRowKey({ cfg, sessionKey: "discord:group:123" })).toBe(
      "agent:ops:discord:group:123",
    );
    expect(resolveSessionRowKey({ cfg, sessionKey: "agent:alpha:main" })).toBe("agent:alpha:main");
  });

  test("resolveSessionRowKey falls back to first list entry when no agent is marked default", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops" }, { id: "review" }] },
    } as OpenClawConfig;
    expect(resolveSessionRowKey({ cfg, sessionKey: "main" })).toBe("agent:ops:main");
    expect(resolveSessionRowKey({ cfg, sessionKey: "discord:group:123" })).toBe(
      "agent:ops:discord:group:123",
    );
  });

  test("resolveSessionRowKey falls back to main when agents.list is missing", () => {
    const cfg = {
      session: { mainKey: "work" },
    } as OpenClawConfig;
    expect(resolveSessionRowKey({ cfg, sessionKey: "main" })).toBe("agent:main:work");
    expect(resolveSessionRowKey({ cfg, sessionKey: "thread-1" })).toBe("agent:main:thread-1");
  });

  test("resolveSessionRowKey normalizes session key casing", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionRowKey({ cfg, sessionKey: "CoP" })).toBe(
      resolveSessionRowKey({ cfg, sessionKey: "cop" }),
    );
    expect(resolveSessionRowKey({ cfg, sessionKey: "MySession" })).toBe("agent:ops:mysession");
    expect(resolveSessionRowKey({ cfg, sessionKey: "agent:ops:CoP" })).toBe("agent:ops:cop");
    expect(resolveSessionRowKey({ cfg, sessionKey: "agent:alpha:MySession" })).toBe(
      "agent:alpha:mysession",
    );
  });

  test("resolveSessionRowKey honors global scope", () => {
    const cfg = {
      session: { scope: "global", mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionRowKey({ cfg, sessionKey: "main" })).toBe("global");
    const target = resolveGatewaySessionDatabaseTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("global");
    expect(target.agentId).toBe("ops");
  });

  test("resolveGatewaySessionDatabaseTarget uses canonical key for main alias", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionDatabaseTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("agent:ops:main");
  });

  test("listAgentsForGateway rejects avatar symlink escapes outside workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-outside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const outsideFile = path.join(root, "outside.txt");
    fs.writeFileSync(outsideFile, "top-secret", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(outsideFile, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBeUndefined();
  });

  test("listAgentsForGateway allows avatar symlinks that stay inside workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-inside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "avatars"), { recursive: true });
    const targetPath = path.join(workspace, "avatars", "actual.png");
    fs.writeFileSync(targetPath, "avatar", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(targetPath, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBe(
      `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`,
    );
  });

  test("listAgentsForGateway keeps explicit agents.list scope over disk-only agents (scope boundary)", async () => {
    await withStateDirEnv("openclaw-agent-list-scope-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "main"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "codex"), { recursive: true });

      const cfg = {
        session: { mainKey: "main" },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const { agents } = listAgentsForGateway(cfg);
      expect(agents.map((agent) => agent.id)).toEqual(["main"]);
    });
  });

  test("listAgentsForGateway includes effective workspace + model for default agent", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          workspace: "/tmp/default-workspace",
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["openai-codex/gpt-5.4"],
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]).toMatchObject({
      id: "main",
      workspace: "/tmp/default-workspace",
      model: {
        primary: "openai/gpt-5.4",
        fallbacks: ["openai-codex/gpt-5.4"],
      },
      agentRuntime: {
        id: "codex",
        source: "implicit",
      },
    });
  });

  test("listAgentsForGateway reports explicit plugin runtime metadata", () => {
    const cfg = {
      session: { mainKey: "main" },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            agentRuntime: { id: "codex" },
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]).toMatchObject({
      id: "main",
      agentRuntime: {
        id: "codex",
        source: "provider",
      },
    });
  });

  test("listAgentsForGateway respects per-agent fallback override (including explicit empty list)", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["openai-codex/gpt-5.4"],
          },
        },
        list: [
          { id: "main", default: true },
          {
            id: "ops",
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: [],
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);
    const ops = result.agents.find((agent) => agent.id === "ops");
    expect(ops?.model).toEqual({ primary: "anthropic/claude-opus-4-6" });
  });
});

describe("resolveSessionModelRef", () => {
  test("prefers explicit session overrides ahead of runtime model fields", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s1",
      updatedAt: Date.now(),
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      modelOverride: "claude-opus-4-6",
      providerOverride: "anthropic",
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
  });

  test("preserves openrouter provider when model contains vendor prefix", () => {
    const cfg = createModelDefaultsConfig({
      primary: "openrouter/minimax/minimax-m2.7",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-or",
      updatedAt: Date.now(),
      modelProvider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });

    expect(resolved).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });
  });

  test("falls back to override when runtime model is not recorded yet", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s2",
      updatedAt: Date.now(),
      modelOverride: "openai-codex/gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "openai-codex", model: "gpt-5.4" });
  });

  test("keeps nested model ids under the stored provider override", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-nested",
      updatedAt: Date.now(),
      providerOverride: "nvidia",
      modelOverride: "moonshotai/kimi-k2.5",
    });

    expect(resolved).toEqual({ provider: "nvidia", model: "moonshotai/kimi-k2.5" });
  });

  test("preserves explicit wrapper providers for vendor-prefixed override models", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-openrouter-override",
      updatedAt: Date.now(),
      providerOverride: "openrouter",
      modelOverride: "anthropic/claude-haiku-4.5",
      modelProvider: "openrouter",
      model: "openrouter/free",
    });

    expect(resolved).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });
  });

  test("strips a duplicated provider prefix from stored overrides", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-qualified-override",
      updatedAt: Date.now(),
      providerOverride: "openai-codex",
      modelOverride: "openai-codex/gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "openai-codex", model: "gpt-5.4" });
  });

  test("falls back to resolved provider for unprefixed legacy runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
      model: "claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({
      provider: "google-gemini-cli",
      model: "claude-sonnet-4-6",
    });
  });

  test("preserves provider from slash-prefixed model when modelProvider is missing", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });
});

describe("listSessionsFromStore selected model display", () => {
  test("async list yields during bulk transcript title and last-message hydration", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-list-yield-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    try {
      const databasePath = path.join(tmpDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      const store: Record<string, SessionEntry> = {};
      const now = Date.now();
      for (let i = 0; i < 11; i += 1) {
        const sessionId = `sess-yield-${i}`;
        store[`agent:main:${sessionId}`] = {
          sessionId,
          updatedAt: now - i,
          modelProvider: "openai",
          model: "gpt-5.4",
          totalTokens: 1,
          totalTokensFresh: true,
          contextTokens: 1,
          estimatedCostUsd: 0,
        } as SessionEntry;
        replaceSqliteSessionTranscriptEvents({
          agentId: "main",
          sessionId,
          events: [
            { type: "session", version: 1, id: sessionId },
            { message: { role: "user", content: `title ${i}` } },
            { message: { role: "assistant", content: `last ${i}` } },
          ],
        });
      }

      const params = {
        cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
        databasePath,
        store,
        opts: { includeDerivedTitles: true, includeLastMessage: true, limit: 11 },
      };
      const expected = listSessionsFromStore(params);
      const listedPromise = listSessionsFromStoreAsync(params);
      let settled = false;
      void listedPromise.then(() => {
        settled = true;
      });

      await Promise.resolve();

      expect(settled).toBe(false);
      const listed = await listedPromise;
      expect(listed.databasePath).toBe(expected.databasePath);
      expect(listed.count).toBe(expected.count);
      expect(listed.defaults).toEqual(expected.defaults);
      expect(listed.sessions).toHaveLength(expected.sessions.length);
      expect(listed.sessions[0]).toEqual(
        expect.objectContaining({
          key: "agent:main:sess-yield-0",
          derivedTitle: "title 0",
          lastMessagePreview: "last 0",
        }),
      );
      expect(listed.sessions[0]?.agentRuntime).toEqual({ id: "codex", source: "implicit" });
      expect(listed.sessions[0]?.thinkingLevel).toBeUndefined();
      expect(listed.sessions[0]?.thinkingLevels?.length).toBeGreaterThan(0);
      expect(listed.sessions[0]?.thinkingOptions?.length).toBeGreaterThan(0);
      expect(listed.sessions[0]?.thinkingDefault).toBe("off");
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("caps transcript title and last-message hydration for bulk list responses", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-list-cap-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    try {
      const databasePath = path.join(tmpDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      const store: Record<string, SessionEntry> = {};
      const now = Date.now();
      for (let i = 0; i < 101; i += 1) {
        const sessionId = `sess-${i}`;
        store[`agent:main:${sessionId}`] = {
          sessionId,
          updatedAt: now - i,
          modelProvider: "openai",
          model: "gpt-5.4",
        } as SessionEntry;
        replaceSqliteSessionTranscriptEvents({
          agentId: "main",
          sessionId,
          events: [
            { type: "session", version: 1, id: sessionId },
            { message: { role: "user", content: `title ${i}` } },
            { message: { role: "assistant", content: `last ${i}` } },
          ],
        });
      }

      const result = await listSessionsFromStoreAsync({
        cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
        databasePath,
        store,
        opts: { includeDerivedTitles: true, includeLastMessage: true, limit: 101 },
      });

      expect(result.sessions).toHaveLength(101);
      expect(result.sessions[0]?.derivedTitle).toBe("title 0");
      expect(result.sessions[0]?.lastMessagePreview).toBe("last 0");
      expect(result.sessions[99]?.derivedTitle).toBe("title 99");
      expect(result.sessions[99]?.lastMessagePreview).toBe("last 99");
      expect(result.sessions[100]?.derivedTitle).toBeUndefined();
      expect(result.sessions[100]?.lastMessagePreview).toBeUndefined();
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("uses bounded top-N selection for small limited lists", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:old": { sessionId: "old", updatedAt: now - 10_000 } as SessionEntry,
      "agent:main:newest": { sessionId: "newest", updatedAt: now } as SessionEntry,
      "agent:main:middle-a": { sessionId: "middle-a", updatedAt: now - 5_000 } as SessionEntry,
      "agent:main:middle-b": { sessionId: "middle-b", updatedAt: now - 5_000 } as SessionEntry,
      "agent:main:newer": { sessionId: "newer", updatedAt: now - 1_000 } as SessionEntry,
    };
    const result = listSessionsFromStore({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      store,
      opts: { limit: 4 },
    });

    expect(result.sessions.map((session) => session.key)).toEqual([
      "agent:main:newest",
      "agent:main:newer",
      "agent:main:middle-a",
      "agent:main:middle-b",
    ]);
  });

  test("shows the selected override model even when a fallback runtime model exists", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const result = listSessionsFromStore({
      cfg,
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          modelProvider: "openai-codex",
          model: "gpt-5.4",
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe("anthropic");
    expect(result.sessions[0]?.model).toBe("claude-opus-4-6");
  });

  test("separates Claude CLI runtime metadata from canonical model identity", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-7",
      agentRuntime: { id: "claude-cli" },
    });

    const result = listSessionsFromStore({
      cfg,
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "claude-cli",
          model: "claude-opus-4-7",
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe("anthropic");
    expect(result.sessions[0]?.model).toBe("claude-opus-4-7");
    expect(result.sessions[0]?.agentRuntime).toEqual({
      id: "claude-cli",
      source: "model",
    });
  });

  test("infers canonical provider for bare CLI models before default-provider fallback", () => {
    const cfg = createModelDefaultsConfig({
      primary: "openai/gpt-5.4",
      models: {
        "anthropic/claude-opus-4-7": {},
      },
      agentRuntime: { id: "claude-cli" },
    });

    const result = listSessionsFromStore({
      cfg,
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "claude-cli",
          model: "claude-opus-4-7",
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe("anthropic");
    expect(result.sessions[0]?.model).toBe("claude-opus-4-7");
  });

  test("uses qualified selected defaults for rows without runtime model metadata", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
        },
        list: [
          { id: "main", model: { primary: "anthropic/claude-sonnet-4-6" } },
          {
            id: "review",
            model: { primary: "vercel-ai-gateway/anthropic/claude-haiku-4-5" },
          },
          { id: "alias", model: { primary: "anthropic/sonnet-4.6" } },
        ],
      },
    } as OpenClawConfig;

    const result = listSessionsFromStore({
      cfg,
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: 2,
        } as SessionEntry,
        "agent:review:review": {
          sessionId: "sess-review",
          updatedAt: 1,
        } as SessionEntry,
        "agent:alias:alias": {
          sessionId: "sess-alias",
          updatedAt: 0,
        } as SessionEntry,
      },
      opts: {},
    });

    expect(
      result.sessions.map((session) => [session.key, session.modelProvider, session.model]),
    ).toEqual([
      ["agent:main:main", "anthropic", "claude-sonnet-4-6"],
      ["agent:review:review", "vercel-ai-gateway", "anthropic/claude-haiku-4-5"],
      ["agent:alias:alias", "anthropic", "claude-sonnet-4-6"],
    ]);
  });

  test("uses persisted runtime model metadata before selected defaults", () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [{ id: "main", model: { primary: "anthropic/claude-sonnet-4-6" } }],
      },
    } as OpenClawConfig;

    const result = listSessionsFromStore({
      cfg,
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "openai-codex",
          model: "gpt-5.5",
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe("openai-codex");
    expect(result.sessions[0]?.model).toBe("gpt-5.5");
  });

  test("uses complete model overrides without default-model fallback", () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [{ id: "main", model: { primary: "anthropic/claude-sonnet-4-6" } }],
      },
    } as OpenClawConfig;

    const result = listSessionsFromStore({
      cfg,
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "sonnet-4.6",
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe("anthropic");
    expect(result.sessions[0]?.model).toBe("claude-sonnet-4-6");
  });
});

describe("resolveSessionModelIdentityRef", () => {
  const resolveLegacyIdentityRef = (cfg: OpenClawConfig, modelProvider?: string) =>
    resolveSessionModelIdentityRef(cfg, {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
      model: "claude-sonnet-4-6",
      modelProvider,
    });

  test("does not inherit default provider for unprefixed legacy runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("infers provider from configured model allowlist when unambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
      models: {
        "anthropic/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  test("infers provider from configured provider catalogs when allowlist is absent", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "custom-provider-runtime-model",
      updatedAt: Date.now(),
      model: "qwen-max",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ provider: "qwen-dashscope", model: "qwen-max" });
  });

  test("keeps provider unknown when configured models are ambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
      models: {
        "anthropic/claude-sonnet-4-6": {},
        "minimax/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("keeps provider unknown when configured provider catalog matches are ambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
        qwen: {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "ambiguous-custom-provider-runtime-model",
      updatedAt: Date.now(),
      model: "qwen-max",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ model: "qwen-max" });
  });

  test("preserves provider from slash-prefixed runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  test("infers wrapper provider for slash-prefixed runtime model when allowlist match is unique", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
      models: {
        "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4-6",
    });
  });
});

describe("resolveSessionDisplayModelIdentityRef", () => {
  test("canonicalizes CLI runtime provider to the selected model provider", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-7",
      agentRuntime: { id: "claude-cli" },
    });

    expect(
      resolveSessionDisplayModelIdentityRef({
        cfg,
        agentId: "main",
        provider: "claude-cli",
        model: "claude-opus-4-7",
      }),
    ).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
  });

  test("prefers configured provider inference over default-provider parsing for bare CLI models", () => {
    const cfg = createModelDefaultsConfig({
      primary: "openai/gpt-5.4",
      models: {
        "anthropic/claude-opus-4-7": {},
      },
      agentRuntime: { id: "claude-cli" },
    });

    expect(
      resolveSessionDisplayModelIdentityRef({
        cfg,
        agentId: "main",
        provider: "claude-cli",
        model: "claude-opus-4-7",
      }),
    ).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
  });
});

describe("deriveSessionTitle", () => {
  test("returns undefined for undefined entry", () => {
    expect(deriveSessionTitle(undefined)).toBeUndefined();
  });

  test("prefers displayName when set", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "My Custom Session",
      subject: "Group Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("My Custom Session");
  });

  test("falls back to subject when displayName is missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      subject: "Dev Team Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Dev Team Chat");
  });

  test("uses first user message when displayName and subject missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry, "Hello, how are you?")).toBe("Hello, how are you?");
  });

  test("truncates long first user message to 60 chars with ellipsis", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg =
      "This is a very long message that exceeds sixty characters and should be truncated appropriately";
    const result = requireString(deriveSessionTitle(entry, longMsg), "truncated session title");
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith("…")).toBe(true);
  });

  test("truncates at word boundary when possible", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg = "This message has many words and should be truncated at a word boundary nicely";
    const result = requireString(deriveSessionTitle(entry, longMsg), "word-boundary session title");
    expect(result.endsWith("…")).toBe(true);
    expect(result.includes("  ")).toBe(false);
  });

  test("falls back to sessionId prefix with date", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: new Date("2024-03-15T10:30:00Z").getTime(),
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234 (2024-03-15)");
  });

  test("falls back to sessionId prefix without date when updatedAt missing", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: 0,
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234");
  });

  test("trims whitespace from displayName", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "  Padded Name  ",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Padded Name");
  });

  test("ignores empty displayName and falls through", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "   ",
      subject: "Actual Subject",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Actual Subject");
  });
});

describe("resolveGatewayModelSupportsImages", () => {
  test("keeps Foundry GPT deployments image-capable even when stale catalog metadata says text-only", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-5.4",
        provider: "microsoft-foundry",
        loadGatewayModelCatalog: async () => [
          { id: "gpt-5.4", name: "GPT-5.4", provider: "microsoft-foundry", input: ["text"] },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("uses the preserved Foundry model name hint for alias deployments with stale text-only input metadata", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "deployment-gpt5",
        provider: "microsoft-foundry",
        loadGatewayModelCatalog: async () => [
          {
            id: "deployment-gpt5",
            name: "gpt-5.4",
            provider: "microsoft-foundry",
            input: ["text"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("treats claude-cli Claude models as image-capable even when catalog metadata is stale or missing", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "claude-sonnet-4-6",
        provider: "claude-cli",
        loadGatewayModelCatalog: async () => [
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            provider: "claude-cli",
            input: ["text"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("matches catalog model ids case-insensitively for explicit providers", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "Qwen/Qwen3.5-35B-A3B",
        provider: "modelscope",
        loadGatewayModelCatalog: async () => [
          {
            id: "qwen/qwen3.5-35b-a3b",
            name: "Qwen3.5 35B",
            provider: "modelscope",
            input: ["text", "image"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("does not borrow image support from another provider when provider is explicit", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [
          { id: "gpt-4", name: "GPT-4", provider: "other", input: ["text", "image"] },
        ],
      }),
    ).resolves.toBe(false);
  });

  test("uses a unique providerless catalog match", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "Qwen/Qwen3.5-35B-A3B",
        loadGatewayModelCatalog: async () => [
          {
            id: "qwen/qwen3.5-35b-a3b",
            name: "Qwen3.5 35B",
            provider: "modelscope",
            input: ["text", "image"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("fails closed on ambiguous providerless catalog matches", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "shared-vision",
        loadGatewayModelCatalog: async () => [
          { id: "shared-vision", name: "Shared Vision", provider: "first", input: ["text"] },
          {
            id: "shared-vision",
            name: "Shared Vision",
            provider: "second",
            input: ["text", "image"],
          },
        ],
      }),
    ).resolves.toBe(false);
  });
});
