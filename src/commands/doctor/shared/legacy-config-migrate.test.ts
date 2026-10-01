// Legacy config migration tests cover generic doctor repair of old config layouts.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { LegacyConfigMigrationContext } from "../../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { legacyCodexProviderIdentityKey } from "./codex-route-model-ref.js";
import { pruneBindingsForMissingAgents } from "./legacy-config-binding-repair.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";
import { collectBlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.js";

function repairBindingsForTest(config: OpenClawConfig) {
  const changes: string[] = [];
  return { config: pruneBindingsForMissingAgents(config, changes), changes };
}

function migrateLegacyConfigForTest(
  raw: unknown,
  context?: LegacyConfigMigrationContext,
): {
  config: OpenClawConfig | null;
  changes: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { config: null, changes: [] };
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes, context);
  }
  const visibleChanges = changes.filter(
    (change) => change !== "Moved agents.list → keyed agents.entries.",
  );
  const agents = next.agents as Record<string, unknown> | undefined;
  const entries = agents?.entries as Record<string, Record<string, unknown>> | undefined;
  if (agents && entries) {
    Object.defineProperty(agents, "list", {
      configurable: true,
      enumerable: false,
      value: Object.entries(entries).map(([id, entry]) => Object.assign({ id }, entry)),
    });
  }
  return visibleChanges.length === 0
    ? { config: null, changes: visibleChanges }
    : { config: next as OpenClawConfig, changes: visibleChanges };
}

describe("legacy session typing config migrate", () => {
  it("preserves session typing precedence over an existing agent default", () => {
    const res = migrateLegacyConfigForTest({
      agents: { defaults: { typingMode: "message" } },
      session: { typingMode: "thinking" },
    });

    expect(res.config?.agents?.defaults?.typingMode).toBe("thinking");
    expect(res.config?.session).toEqual({});
    expect(res.changes).toContain(
      "Moved session.typingMode → agents.defaults.typingMode (replaced the previously shadowed agent default).",
    );
  });
});

describe("compatibility binding repair migrate", () => {
  it("preserves exact main bindings because the implicit main agent always exists", () => {
    const res = repairBindingsForTest({
      agents: {
        list: [{ id: "ALPHA" }],
      },
      bindings: [
        { agentId: "main", match: { channel: "discord" } },
        { agentId: "alpha", match: { channel: "discord" } },
        { agentId: "MAIN", match: { channel: "discord" } },
        { agentId: "ghost", match: { channel: "discord" } },
      ],
    } as OpenClawConfig);

    expect(res.config.bindings).toEqual([
      { agentId: "main", match: { channel: "discord" } },
      { agentId: "alpha", match: { channel: "discord" } },
    ]);
    expect(res.changes).toContain("Removed 2 bindings that referenced missing agents.list ids.");
  });

  it("leaves bindings untouched when agents.list has malformed entries", () => {
    const cfg = {
      agents: {
        list: [null, { id: 1 }, { id: "alpha" }],
      },
      bindings: [
        { agentId: "ghost", match: { channel: "discord" } },
        { agentId: "alpha", match: { channel: "discord" } },
      ],
    } as unknown as OpenClawConfig;

    const res = repairBindingsForTest(cfg);

    expect(res.config.bindings).toEqual(cfg.bindings);
    expect(res.changes).not.toContain("Removed 1 binding that referenced missing agents.list ids.");
  });
});

describe("legacy MCP server config migrate", () => {
  it("moves disabled to enabled, preserves canonical values, and is idempotent", () => {
    const raw = {
      mcp: {
        servers: {
          disabled: { command: "example-mcp", disabled: true },
          enabled: { command: "example-mcp", disabled: false },
          canonical: { command: "example-mcp", disabled: true, enabled: true },
        },
      },
    };

    expect(findLegacyConfigIssues(raw)).toEqual([
      expect.objectContaining({
        path: "mcp.servers",
        message: expect.stringContaining('unsupported "disabled" key'),
      }),
    ]);
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.mcp?.servers).toEqual({
      disabled: { command: "example-mcp", enabled: false },
      enabled: { command: "example-mcp", enabled: true },
      canonical: { command: "example-mcp", enabled: true },
    });
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
  });

  it("moves MCP workingDirectory aliases to cwd with canonical values winning", () => {
    const raw = {
      mcp: {
        servers: {
          legacy: { command: "example-mcp", workingDirectory: "/legacy" },
          canonical: { command: "example-mcp", cwd: "/canonical", workingDirectory: "/legacy" },
        },
      },
      nodeHost: {
        mcp: {
          servers: {
            legacy: { command: "example-mcp", workingDirectory: "/node-legacy" },
          },
        },
      },
    };

    expect(findLegacyConfigIssues(raw)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "mcp.servers",
          message: expect.stringContaining("use camelCase spellings and cwd"),
        }),
        expect.objectContaining({
          path: "nodeHost.mcp.servers",
          message: expect.stringContaining("use camelCase spellings and cwd"),
        }),
      ]),
    );
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.mcp?.servers).toEqual({
      legacy: { command: "example-mcp", cwd: "/legacy" },
      canonical: { command: "example-mcp", cwd: "/canonical" },
    });
    expect(res.config?.nodeHost?.mcp?.servers?.legacy).toEqual({
      command: "example-mcp",
      cwd: "/node-legacy",
    });
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
  });
});

function migrateProviderConfig(providers: Record<string, unknown>) {
  return migrateLegacyConfigForTest({ models: { providers } });
}

describe("legacy Codex provider config migrate", () => {
  it("moves legacy OpenAI Codex provider config to canonical OpenAI provider config", () => {
    const res = migrateProviderConfig({
      "openai-codex": {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        api: "openai-codex-responses",
        models: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            api: "openai-codex-responses",
          },
        ],
      },
    });

    expect(res.config?.models?.providers?.openai).toEqual({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      api: "openai-chatgpt-responses",
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          api: "openai-chatgpt-responses",
        },
      ],
    });
    expect(res.config?.models?.providers).not.toHaveProperty("openai-codex");
  });

  it("normalizes moved shipped codex model auto runtime and preserves explicit overrides", () => {
    const res = migrateProviderConfig({
      codex: {
        models: [
          { id: "gpt-missing" },
          { id: "gpt-auto", agentRuntime: { id: "auto" } },
          { id: "gpt-openclaw", agentRuntime: { id: "openclaw" } },
        ],
      },
    });

    expect(res.config?.models?.providers?.openai?.models).toEqual([
      { id: "gpt-missing", agentRuntime: { id: "codex" } },
      { id: "gpt-auto", agentRuntime: { id: "codex" } },
      { id: "gpt-openclaw", agentRuntime: { id: "openclaw" } },
    ]);
    expect(res.config?.models?.providers).not.toHaveProperty("codex");
  });

  it("normalizes merged shipped codex model auto runtime and preserves explicit overrides", () => {
    const res = migrateProviderConfig({
      openai: { models: [{ id: "text-embedding-3-small" }] },
      codex: {
        models: [
          { id: "gpt-auto", agentRuntime: { id: "auto" } },
          { id: "gpt-openclaw", agentRuntime: { id: "openclaw" } },
        ],
      },
    });

    expect(res.config?.models?.providers?.openai?.models).toEqual([
      { id: "text-embedding-3-small" },
      { id: "gpt-auto", agentRuntime: { id: "codex" } },
      { id: "gpt-openclaw", agentRuntime: { id: "openclaw" } },
    ]);
    expect(res.config?.models?.providers).not.toHaveProperty("codex");
  });

  it("keeps conflicting shipped codex provider config for manual review", () => {
    const res = migrateProviderConfig({
      openai: {
        models: [{ id: "text-embedding-3-small" }],
      },
      codex: {
        auth: "oauth",
        headers: { Authorization: "Bearer synthetic" },
        api: "openai-codex-responses",
        models: [{ id: "gpt-5.6-sol", api: "openai-codex-responses" }],
      },
    });

    expect(res.config?.models?.providers?.codex).toEqual({
      auth: "oauth",
      headers: { Authorization: "Bearer synthetic" },
      api: "openai-chatgpt-responses",
      models: [{ id: "gpt-5.6-sol", api: "openai-chatgpt-responses" }],
    });
    expect(res.config?.models?.providers?.openai).toEqual({
      models: [{ id: "text-embedding-3-small" }],
    });
    expect(res.changes).toContain(
      "Skipped merging models.providers.codex into models.providers.openai because provider-level defaults cannot be represented safely on merged models: models.providers.codex.auth, models.providers.codex.headers.",
    );
    expect(collectBlockedLegacyOpenAICodexProviderPlan(res.config).warning).toEqual(
      expect.stringContaining("models.providers.codex cannot be merged automatically"),
    );
    expect(collectBlockedLegacyOpenAICodexProviderPlan(res.config).blockedModelIdentities).toEqual([
      expectDefined(
        legacyCodexProviderIdentityKey("codex"),
        "provider-default blocked namespace test invariant",
      ),
    ]);
  });

  it("keeps non-equivalent same-id shipped codex models for manual review", () => {
    const res = migrateProviderConfig({
      openai: {
        apiKey: "placeholder",
        models: [
          {
            id: "gpt-5.6-sol",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
      },
      codex: {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        models: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.4-mini" }],
      },
    });

    expect(res.config?.models?.providers?.codex).toEqual({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      models: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.4-mini" }],
    });
    expect(res.config?.models?.providers?.openai?.models).toEqual([
      {
        id: "gpt-5.6-sol",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    ]);
    expect(res.changes).toContain(
      "Skipped merging models.providers.codex into models.providers.openai because colliding model definitions differ for: gpt-5.6-sol.",
    );
    expect(collectBlockedLegacyOpenAICodexProviderPlan(res.config).warning).toEqual(
      expect.stringContaining("colliding model definitions differ for: gpt-5.6-sol"),
    );
    expect(collectBlockedLegacyOpenAICodexProviderPlan(res.config).blockedModelIdentities).toEqual([
      expectDefined(
        legacyCodexProviderIdentityKey("codex"),
        "blocked provider namespace test invariant",
      ),
    ]);
  });

  it("removes equivalent same-id shipped codex models", () => {
    const res = migrateProviderConfig({
      openai: {
        models: [
          {
            id: "gpt-5.6-sol",
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api",
            agentRuntime: { id: "codex" },
          },
        ],
      },
      codex: {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        models: [{ id: "gpt-5.6-sol" }],
      },
    });

    expect(res.config?.models?.providers).not.toHaveProperty("codex");
    expect(res.config?.models?.providers?.openai?.models).toEqual([
      {
        id: "gpt-5.6-sol",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        agentRuntime: { id: "codex" },
      },
    ]);
    expect(res.changes).toContain(
      "Removed models.providers.codex because models.providers.openai already exists.",
    );
  });

  it("preserves model-scoped defaults and overrides when later OpenAI normalization runs", () => {
    const res = migrateProviderConfig({
      "openai-codex": {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        contextWindow: 200000,
        contextTokens: 180000,
        maxTokens: 8192,
        params: { store: false, reasoning: { effort: "medium" } },
        agentRuntime: { id: "codex" },
        models: [
          {
            id: "gpt-5.5",
            name: "Chat",
            params: { reasoning: { effort: "high" }, verbosity: "low" },
          },
          { id: "gpt-5.4" },
        ],
      },
      openai: {
        api: "openai-codex-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "text-embedding-3-small", name: "Chat", api: "openai-codex-responses" }],
      },
    });
    expect(res.config?.models?.providers).not.toHaveProperty("openai-codex");
    expect(res.config?.models?.providers?.openai).toEqual({
      api: "openai-chatgpt-responses",
      baseUrl: "https://api.openai.com/v1",
      models: [
        { id: "text-embedding-3-small", name: "Chat", api: "openai-chatgpt-responses" },
        {
          id: "gpt-5.5",
          name: "Chat",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          contextWindow: 200000,
          contextTokens: 180000,
          maxTokens: 8192,
          params: { store: false, reasoning: { effort: "high" }, verbosity: "low" },
          agentRuntime: { id: "codex" },
        },
        {
          id: "gpt-5.4",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          contextWindow: 200000,
          contextTokens: 180000,
          maxTokens: 8192,
          params: { store: false, reasoning: { effort: "medium" } },
          agentRuntime: { id: "codex" },
        },
      ],
    });
  });

  it("preserves legacy models-add metadata marker when merging codex models", () => {
    const res = migrateProviderConfig({
      openai: {
        api: "openai-chatgpt-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "text-embedding-3-small" }],
      },
      "openai-codex": {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        models: [
          {
            id: "gpt-5.5",
            api: "openai-chatgpt-responses",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
            contextWindow: 400_000,
            contextTokens: 272_000,
            maxTokens: 128_000,
          },
        ],
      },
    });

    const openai = res.config?.models?.providers?.openai as Record<string, unknown> | undefined;
    expect(openai?.models).toEqual([
      { id: "text-embedding-3-small" },
      {
        id: "gpt-5.5",
        api: "openai-chatgpt-responses",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
        contextWindow: 400_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
        baseUrl: "https://chatgpt.com/backend-api",
        metadataSource: "models-add",
      },
    ]);
    expect(res.config?.models?.providers).not.toHaveProperty("openai-codex");
  });

  it("does not report a fixable legacy issue after blocked codex merge normalization already ran", () => {
    const raw = {
      models: {
        providers: {
          openai: {
            api: "openai-chatgpt-responses",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "placeholder",
            params: { store: true },
            request: { retry: { maxAttempts: 1 } },
            models: [{ id: "text-embedding-3-small" }],
          },
          "openai-codex": {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api",
            models: [{ id: "gpt-5.5", api: "openai-chatgpt-responses" }],
          },
        },
      },
    };
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.models).toEqual(raw.models);
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "openai/text-embedding-3-small",
    });
    expect(collectBlockedLegacyOpenAICodexProviderPlan(res.config).blockedModelIdentities).toEqual([
      expectDefined(legacyCodexProviderIdentityKey("openai-codex"), "blocked legacy namespace"),
    ]);
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).not.toContain(
      "models.providers",
    );
  });
});

describe("legacy silent reply config migrate", () => {
  it("removes silent reply rewrite plus direct and internal silent reply config", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          silentReply: { direct: "allow", group: "allow", internal: "allow" },
          silentReplyRewrite: { direct: true, group: false },
        },
      },
      surfaces: {
        telegram: {
          silentReply: { direct: "disallow", group: "allow", internal: "allow" },
          silentReplyRewrite: { direct: true },
        },
      },
    });
    expect(res.config?.agents?.defaults).toEqual({
      silentReply: { group: "allow" },
    });
    expect(res.config?.surfaces?.telegram).toEqual({ silentReply: { group: "allow" } });
  });
});

describe("legacy agent system prompt override config migrate", () => {
  it("removes default and per-agent system prompt overrides", () => {
    const raw = {
      agents: {
        defaults: {
          systemPromptOverride: "old default prompt",
          model: { primary: "openai/gpt-5.5" },
        },
        list: [{ id: "alpha", systemPromptOverride: "old alpha prompt" }, { id: "beta" }],
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual([
      "agents.defaults.systemPromptOverride",
      "agents",
      "agents.list",
    ]);

    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.agents?.defaults).not.toHaveProperty("systemPromptOverride");
    expect(res.config?.agents?.list?.[0]).not.toHaveProperty("systemPromptOverride");
    expect(res.config?.agents?.list?.[1]).toEqual({ id: "beta" });
  });
});

describe("profile configured tool section migrate", () => {
  it("does not add grants when configured sections are the only signal", () => {
    const raw = {
      tools: {
        profile: "messaging",
        alsoAllow: ["read", "write"],
        exec: { security: "allowlist" },
        fs: { workspaceOnly: true },
        byProvider: { openai: { profile: "messaging" } },
      },
      agents: { list: [{ id: "sage", tools: { exec: { security: "allowlist" } } }] },
    };
    expect(migrateLegacyConfigForTest(raw)).toEqual({ config: null, changes: [] });
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).not.toContain("tools");
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain("agents.list");
  });

  it("does not infer configured-section grants from unrelated allowlists or top-level provider profiles", () => {
    const raw = {
      tools: {
        profile: "messaging",
        allow: ["message", "sessions_*", "gmail_search"],
        exec: { security: "allowlist" },
        byProvider: { openai: { allow: ["message", "exec", "process"] } },
      },
    };
    expect(migrateLegacyConfigForTest(raw)).toEqual({ config: null, changes: [] });
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).not.toContain("tools");
  });

  it("repairs explicit grants per scope without broadening wildcard or alsoAllow intent", () => {
    const res = migrateLegacyConfigForTest({
      tools: {
        profile: "messaging",
        allow: ["message", "exec", "process"],
        alsoAllow: ["browser"],
        exec: { security: "allowlist" },
        byProvider: { openai: { profile: "messaging", allow: ["message", "exec", "process"] } },
      },
      agents: {
        list: [
          {
            id: "direct",
            tools: { allow: ["message", "exec", "process"], exec: { security: "allowlist" } },
          },
          {
            id: "also",
            tools: { allow: ["message"], alsoAllow: ["exec"], exec: { security: "allowlist" } },
          },
          {
            id: "broad",
            tools: { profile: "messaging", allow: ["*"], exec: { security: "allowlist" } },
          },
        ],
      },
    });
    expect(res.config?.tools).toEqual({
      profile: "full",
      allow: ["message", "browser", "exec", "process"],
      exec: { security: "allowlist" },
      byProvider: { openai: { profile: "full", allow: ["message", "exec", "process"] } },
    });
    expect(res.config?.agents?.list?.[0]?.tools).toEqual({
      profile: "full",
      allow: ["message", "exec", "process"],
      exec: { security: "allowlist" },
    });
    expect(res.config?.agents?.list?.[1]?.tools).toEqual({
      profile: "full",
      allow: ["message", "exec"],
      exec: { security: "allowlist" },
    });
    const broad = res.config?.agents?.list?.[2]?.tools;
    expect(broad?.profile).toBe("full");
    expect(broad?.allow).toEqual(expect.arrayContaining(["message", "exec", "process"]));
    expect(broad?.allow).not.toContain("*");
    expect(broad?.allow).not.toContain("read");
  });

  it("ignores blocked inherited provider keys while resolving provider repairs", () => {
    const raw = JSON.parse(
      '{"tools":{"byProvider":{"__proto__":{"profile":"messaging"},"qwen":{"profile":"messaging"}}},"agents":{"list":[{"id":"sage","tools":{"exec":{"security":"allowlist"},"byProvider":{"qwen/qwen-plus":{"allow":["message","exec","process"]}}}}]}}',
    );
    const res = migrateLegacyConfigForTest(raw);

    expect(Object.prototype).not.toHaveProperty("profile");
    expect(res.config?.agents?.list?.[0]?.tools?.byProvider?.["qwen/qwen-plus"]?.allow).toEqual([
      "message",
      "exec",
      "process",
    ]);
    expect(res.config?.agents?.list?.[0]?.tools?.byProvider?.["qwen/qwen-plus"]?.profile).toBe(
      "full",
    );
  });
});

describe("legacy agent model timeout migrate", () => {
  it("removes ignored timeoutMs from agent and subagent model selection config", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
            timeoutMs: 30_000,
          },
          subagents: { model: { primary: "openai/gpt-5.4", timeoutMs: 10_000 } },
          imageGenerationModel: {
            primary: "openrouter/openai/gpt-5.4-image-2",
            timeoutMs: 180_000,
          },
          pdfModel: { primary: "openai/gpt-5.5", timeoutMs: 45_000 },
        },
        list: [
          {
            id: "worker",
            model: { primary: "openai/gpt-5.4", timeoutMs: 20_000 },
            subagents: { model: { primary: "openai/gpt-5.4-mini", timeoutMs: 5_000 } },
          },
        ],
      },
    });
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
    expect(res.config?.agents?.defaults?.subagents?.model).toEqual({ primary: "openai/gpt-5.4" });
    expect(res.config?.agents?.defaults?.mediaModels).toEqual({
      image: { primary: "openrouter/openai/gpt-5.4-image-2", timeoutMs: 180_000 },
    });
    expect(res.config?.agents?.defaults?.pdfModel).toEqual({
      primary: "openai/gpt-5.5",
      timeoutMs: 45_000,
    });
    expect(res.config?.agents?.list?.[0]?.model).toEqual({ primary: "openai/gpt-5.4" });
    expect(res.config?.agents?.list?.[0]?.subagents?.model).toEqual({
      primary: "openai/gpt-5.4-mini",
    });
  });
});

describe("legacy session maintenance migrate", () => {
  it("removes deprecated session.maintenance.rotateBytes", () => {
    const res = migrateLegacyConfigForTest({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          maxEntries: 500,
          rotateBytes: "10mb",
        },
      },
    });

    expect(res.config?.session?.maintenance).toEqual({
      mode: "enforce",
      pruneAfter: "30d",
      maxEntries: 500,
    });
  });
});

describe("legacy session parent fork migrate", () => {
  it("removes legacy session.parentForkMaxTokens", () => {
    const res = migrateLegacyConfigForTest({
      session: {
        store: "sessions.json",
        parentForkMaxTokens: 200_000,
      },
    });

    expect(res.config?.session).toEqual({
      store: "sessions.json",
    });
  });
});

describe("legacy diagnostics OTel protocol migrate", () => {
  it.each([
    {
      name: "enabled telemetry",
      otel: { enabled: true, endpoint: "http://otel-collector:4317" },
      expected: { enabled: false, endpoint: "http://otel-collector:4317" },
    },
    {
      name: "OTLP logs",
      otel: { enabled: true, traces: false, metrics: false, logs: true, logsExporter: "otlp" },
      expected: { enabled: false, traces: false, metrics: false, logs: true, logsExporter: "otlp" },
    },
    {
      name: "no enabled signals",
      otel: { enabled: true, traces: false, metrics: false, logs: false },
      expected: { enabled: true, traces: false, metrics: false, logs: false },
    },
    {
      name: "disabled telemetry",
      otel: { enabled: false, endpoint: "http://otel-collector:4317" },
      expected: { enabled: false, endpoint: "http://otel-collector:4317" },
    },
  ])("removes unsupported grpc without disabling working signals: $name", ({ otel, expected }) => {
    const res = migrateLegacyConfigForTest({
      diagnostics: { otel: { ...otel, protocol: "grpc" } },
    });
    expect(res.config?.diagnostics?.otel).toEqual(expected);
  });

  it("repairs a config-interpolated grpc protocol using the resolved value", () => {
    const otel = {
      enabled: true,
      traces: false,
      metrics: false,
      logs: true,
      logsExporter: "stdout",
    };
    const authored = { diagnostics: { otel: { ...otel, protocol: "${OTEL_PROTOCOL}" } } };
    const resolved = { diagnostics: { otel: { ...otel, protocol: "grpc" } } };
    const res = migrateLegacyConfigForTest(authored, {
      authoredRaw: authored,
      resolvedRaw: resolved,
    });
    expect(res.config?.diagnostics?.otel).toEqual({
      enabled: true,
      traces: false,
      metrics: false,
      logs: true,
      logsExporter: "stdout",
    });
  });
});

describe("retired gateway Tailscale cleanup config migrate", () => {
  it.each([[true, "managed Tailscale routes now end automatically"]])(
    "removes resetOnExit=%s while preserving sibling settings",
    (resetOnExit, message) => {
      const raw = {
        gateway: {
          bind: "loopback",
          tailscale: {
            mode: "serve",
            resetOnExit,
            preserveFunnel: true,
          },
        },
      };

      expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain(
        "gateway.tailscale.resetOnExit",
      );
      const res = migrateLegacyConfigForTest(raw);

      expect(res.config?.gateway?.tailscale).toEqual({
        mode: "serve",
        preserveFunnel: true,
      });
      expect(res.changes).toEqual([expect.stringContaining(message)]);
      expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
    },
  );

  it("removes a managed Service and disables ingress until the operator chooses a device route", () => {
    const raw = {
      gateway: {
        bind: "loopback",
        tailscale: {
          mode: "serve",
          serviceName: "svc:openclaw",
        },
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain(
      "gateway.tailscale.serviceName",
    );
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.gateway?.tailscale).toEqual({ mode: "off" });
    expect(res.changes).toEqual([
      expect.stringMatching(/serviceName.*mode=off.*tailscale serve clear/s),
    ]);
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
  });

  it("removes an ignored Service name without disabling Funnel", () => {
    const raw = {
      gateway: {
        tailscale: {
          mode: "funnel",
          serviceName: "svc:ignored",
        },
      },
    };

    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.gateway?.tailscale).toEqual({ mode: "funnel" });
    expect(res.changes).toEqual([expect.stringContaining("current Tailscale mode is unchanged")]);
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
  });
});

describe("retired cron run-log config migrate", () => {
  it("removes cron.runLog while preserving current cron config", () => {
    const raw = {
      cron: {
        enabled: true,
        runLog: { maxBytes: "2mb", keepLines: 100 },
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain("cron.runLog");
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.cron).toEqual({ enabled: true });
    expect(res.changes).toContain(
      "Removed retired cron.runLog config; cron history now keeps 2000 runs per job.",
    );
  });
});

describe("legacy thread binding spawn migrate", () => {
  it("collapses split spawn flags per scope and resolves conflicts conservatively", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        discord: {
          threadBindings: { enabled: true, spawnSubagentSessions: true, spawnAcpSessions: true },
          accounts: {
            work: { threadBindings: { spawnSubagentSessions: true, spawnAcpSessions: false } },
          },
        },
      },
    });
    expect(res.config).toHaveProperty("channels.discord.threadBindings", {
      enabled: true,
      spawnSessions: true,
    });
    expect(res.config).toHaveProperty("channels.discord.accounts.work.threadBindings", {
      spawnSessions: false,
    });
  });
});

describe("legacy message queue mode migrate", () => {
  it("moves retired queue steering modes to followup mode", () => {
    const res = migrateLegacyConfigForTest({
      messages: {
        queue: {
          mode: "queue",
          byChannel: {
            discord: "steer-backlog",
            telegram: "collect",
            slack: "steer",
          },
        },
      },
    });

    expect(res.config?.messages?.queue).toEqual({
      mode: "steer",
      byChannel: {
        discord: "followup",
        telegram: "collect",
        slack: "steer",
      },
    });
    expect(res.changes).toContain(
      'Moved deprecated messages.queue.mode "queue" → "steer"; use "steer" for default active-run steering.',
    );
    expect(res.changes).toContain(
      'Moved deprecated messages.queue.byChannel.discord "steer-backlog" → "followup"; use "steer" for default active-run steering.',
    );
  });
});

describe("legacy migrate audio transcription", () => {
  it("consolidates existing per-capability media config without reviving removed routing keys", () => {
    const res = migrateLegacyConfigForTest({
      routing: {
        transcribeAudio: {
          command: ["whisper", "--model", "tiny"],
        },
      },
      tools: {
        media: {
          audio: {
            models: [{ command: "existing", type: "cli" }],
          },
        },
      },
    });

    expect(res.config?.tools?.media).toEqual({
      models: [{ command: "existing", type: "cli", capabilities: ["audio"] }],
    });
  });

  it("drops invalid audio.transcription payloads", () => {
    const raw = {
      audio: {
        transcription: {
          command: [{}],
        },
      },
    };

    expect(findLegacyConfigIssues(raw)).toEqual([
      {
        path: "audio.transcription",
        message: "Use a capability-tagged tools.media.models entry instead.",
      },
    ]);
    const res = migrateLegacyConfigForTest(raw);

    expect(res.changes).toStrictEqual(["Removed audio.transcription (invalid or empty command)."]);
    expect(res.config).not.toHaveProperty("audio");
    expect(res.config?.tools?.media?.audio).toBeUndefined();
  });

  it("rewrites legacy audio {input} placeholders to media templates", () => {
    const raw = {
      tools: {
        media: {
          models: [{ provider: "openai", model: "vision", capabilities: ["image"] }],
          audio: { models: [{ provider: "openai", model: "vision", capabilities: ["image"] }] },
        },
      },
      audio: {
        transcription: {
          command: ["whisper-cli", "--model", "small", "{input}", "--input={input}"],
          timeoutSeconds: 30,
        },
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain("audio.transcription");
    const res = migrateLegacyConfigForTest(raw);

    expect(res.changes).toContain("Moved audio.transcription → tools.media.models.");
    expect(res.config).not.toHaveProperty("audio");
    expect(res.config?.tools?.media?.models).toEqual([
      { provider: "openai", model: "vision", capabilities: ["image"] },
      {
        type: "cli",
        command: "whisper-cli",
        args: ["--model", "small", "{{AttachmentPath}}", "--input={{AttachmentPath}}"],
        timeoutSeconds: 30,
        capabilities: ["audio"],
      },
    ]);
    expect(res.config?.tools?.media?.audio).toEqual({
      enabled: true,
      preferredModel: "cli:whisper-cli",
    });
  });
});

describe("legacy agent runtime and sandbox config migrate", () => {
  it("removes ignored agent-wide runtime policy", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          agentRuntime: { fallback: "openclaw" },
        },
        list: [
          {
            id: "reviewer",
            agentRuntime: { fallback: "openclaw" },
          },
        ],
      },
    });

    expect(res.config?.agents?.defaults).toStrictEqual({});
    expect(res.config?.agents?.list?.[0]).toEqual({
      id: "reviewer",
    });
  });

  it("moves recoverable whole-agent Claude CLI runtime policy before removing stale pins", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"],
          },
          models: {
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "openclaw" } },
            "anthropic/claude-opus-4-7": {
              alias: "Opus",
              agentRuntime: { id: "auto", mode: "strict" },
            },
          },
        },
        list: [
          {
            id: "paige",
            agentRuntime: { id: "claude-cli" },
            model: "anthropic/claude-sonnet-4-6",
          },
        ],
      },
    });

    expect(res.config?.agents?.defaults).toEqual({
      model: {
        primary: "anthropic/claude-opus-4-7",
        fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"],
      },
      models: {
        "anthropic/claude-opus-4-7": {
          alias: "Opus",
          agentRuntime: { id: "claude-cli", mode: "strict" },
        },
        "anthropic/claude-sonnet-4-6": {
          agentRuntime: { id: "openclaw" },
        },
      },
      modelPolicy: {
        allow: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-7"],
      },
    });
    expect(res.config?.agents?.list?.[0]).toEqual({
      id: "paige",
      model: "anthropic/claude-sonnet-4-6",
      models: {
        "anthropic/claude-sonnet-4-6": {
          agentRuntime: { id: "claude-cli" },
        },
      },
    });
  });

  it("disables the default sandbox browser network without granting inherited egress", () => {
    const raw = {
      agents: {
        defaults: {
          sandbox: {
            browser: {
              enabled: true,
              network: " NONE ",
              autoStart: false,
            },
          },
        },
        entries: {
          main: {
            default: true,
            sandbox: { browser: { enabled: true, network: "none", headless: true } },
          },
          inherited: {
            sandbox: {
              browser: {
                enabled: true,
                headless: true,
              },
            },
          },
          isolated: {
            sandbox: {
              browser: {
                network: "isolated-browser-net",
              },
            },
          },
          blankEnabled: {
            sandbox: {
              browser: {
                enabled: true,
                network: "   ",
              },
            },
          },
          blankInherited: {
            sandbox: {
              browser: {
                network: "",
              },
            },
          },
        },
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual([
      "agents.defaults.sandbox.browser.network",
      "agents",
    ]);
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.agents?.entries?.main?.sandbox?.browser).toEqual({
      enabled: false,
      network: "openclaw-sandbox-browser",
      headless: true,
    });
    expect(res.config?.agents?.defaults?.sandbox?.browser).toEqual({
      enabled: false,
      network: "openclaw-sandbox-browser",
      autoStart: false,
    });
    expect(res.config?.agents?.entries?.inherited?.sandbox?.browser).toEqual({
      enabled: false,
      headless: true,
    });
    expect(res.config?.agents?.entries?.isolated?.sandbox?.browser).toEqual({
      enabled: true,
      network: "isolated-browser-net",
    });
    expect(res.config?.agents?.entries?.blankEnabled?.sandbox?.browser).toEqual({
      enabled: true,
      network: "   ",
    });
    expect(res.config?.agents?.entries?.blankInherited?.sandbox?.browser).toEqual({
      enabled: true,
      network: "",
    });
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
  });

  it("disables explicit per-agent network none in legacy list rosters", () => {
    const raw = {
      agents: {
        list: [
          {
            id: "legacy",
            default: true,
            sandbox: {
              browser: {
                network: "NONE",
                autoStart: false,
              },
            },
          },
        ],
      },
    };

    expect(findLegacyConfigIssues(raw)).toContainEqual({
      path: "agents",
      message: expect.stringContaining('sandbox.browser.network = "none"'),
    });
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.agents?.entries?.legacy?.sandbox?.browser).toEqual({
      enabled: false,
      network: "openclaw-sandbox-browser",
      autoStart: false,
    });
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
  });
});

describe("legacy migrate MCP server type aliases", () => {
  it("normalizes CLI-native transports while preserving explicit canonical transport", () => {
    const res = migrateLegacyConfigForTest({
      mcp: {
        servers: {
          http: { type: "http", url: "https://example.com/mcp" },
          sse: { type: "sse", url: "https://example.com/sse" },
          canonical: { type: "http", transport: "sse", url: "https://example.com/canonical" },
        },
      },
    });
    expect(res.config?.mcp?.servers).toEqual({
      http: { transport: "streamable-http", url: "https://example.com/mcp" },
      sse: { transport: "sse", url: "https://example.com/sse" },
      canonical: { transport: "sse", url: "https://example.com/canonical" },
    });
  });
});

describe("legacy migrate x_search auth", () => {
  it("moves only legacy x_search auth into plugin-owned xai config", () => {
    const res = migrateLegacyConfigForTest({
      tools: {
        web: {
          x_search: {
            apiKey: "xai-legacy-key",
            enabled: true,
            model: "grok-4-1-fast",
          },
        },
      },
    });

    expect((res.config?.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
      model: "grok-4-1-fast",
    });
    expect(res.config?.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "xai-legacy-key",
        },
      },
    });
  });

  it("detects and repairs retired xAI model-only tool config without plugin discovery", () => {
    const raw = {
      tools: {
        web: {
          search: { grok: { model: "grok-4-1-fast" } },
          x_search: { model: "grok-4-1-fast-non-reasoning" },
        },
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["tools.web.search", "tools.web.x_search.model"]),
    );

    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: { webSearch: { model: "grok-4.3" } },
    });
    expect((res.config?.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      model: "grok-4.3",
    });
    expect(res.changes).toEqual(
      expect.arrayContaining([
        'Updated tools.web.search.grok.model from "grok-4-1-fast" to "grok-4.3".',
        'Updated tools.web.x_search.model from "grok-4-1-fast-non-reasoning" to "grok-4.3".',
      ]),
    );
  });
});

describe("legacy Codex Supervisor config migrate", () => {
  it("moves active Supervisor config into Codex supervision and rewrites the allowlist", () => {
    const raw = {
      plugins: {
        allow: ["telegram", "codex-supervisor", "codex"],
        entries: {
          "codex-supervisor": {
            enabled: true,
            config: {
              endpoints: [
                {
                  id: "local",
                  transport: "stdio-proxy",
                  command: "codex",
                },
              ],
              allowRawTranscripts: true,
              allowWriteControls: true,
            },
            hooks: { enabled: true },
          },
        },
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain("plugins");

    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.plugins?.allow).toEqual(["telegram", "codex"]);
    expect(res.config?.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: {
        supervision: {
          enabled: true,
          endpoints: [
            {
              id: "local",
              transport: "stdio-proxy",
              command: "codex",
            },
          ],
          allowRawTranscripts: true,
          allowWriteControls: true,
        },
      },
    });
    expect(res.config?.plugins?.entries?.["codex-supervisor"]).toBeUndefined();
    expect(res.changes).toContain(
      "Moved plugins.entries.codex-supervisor to plugins.entries.codex.config.supervision.",
    );
    expect(res.changes).toContain("Rewrote plugins.allow codex-supervisor references to codex.");

    const rerun = migrateLegacyConfigForTest(res.config);
    expect(rerun).toEqual({ config: null, changes: [] });
  });

  it("does not disable an existing implicit Codex harness when old supervision was disabled", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
      plugins: {
        entries: {
          codex: {
            config: {
              appServer: { transport: "stdio" },
            },
          },
          "codex-supervisor": {
            enabled: false,
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(res.config?.plugins?.entries?.codex).toEqual({
      config: {
        appServer: { transport: "stdio" },
        supervision: { enabled: false },
      },
    });
  });

  it("preserves canonical Codex values while filling missing supervision fields", () => {
    const res = migrateLegacyConfigForTest({
      plugins: {
        deny: [" CODEX-SUPERVISOR ", "telegram"],
        entries: {
          " CODEX ": {
            enabled: false,
            config: {
              appServer: { transport: "stdio" },
              supervision: {
                enabled: true,
                endpoints: [{ id: "canonical", transport: "stdio-proxy" }],
                allowWriteControls: false,
              },
            },
          },
          " CODEX-SUPERVISOR ": {
            enabled: true,
            config: {
              endpoints: [{ id: "legacy", transport: "stdio-proxy" }],
              allowRawTranscripts: true,
              allowWriteControls: true,
            },
          },
        },
      },
    });

    expect(res.config?.plugins?.deny).toEqual(["telegram"]);
    expect(res.config?.plugins?.entries?.[" CODEX "]).toEqual({
      enabled: false,
      config: {
        appServer: { transport: "stdio" },
        supervision: {
          enabled: true,
          endpoints: [{ id: "canonical", transport: "stdio-proxy" }],
          allowRawTranscripts: true,
          allowWriteControls: false,
        },
      },
    });
    expect(res.changes).toContain("Removed plugins.deny codex-supervisor references.");
  });

  it("keeps migrated supervision dormant when the old plugin was denied", () => {
    const res = migrateLegacyConfigForTest({
      plugins: {
        deny: ["codex-supervisor"],
        entries: { "codex-supervisor": { enabled: true, config: { allowWriteControls: true } } },
      },
    });
    expect(res.config?.plugins?.deny).toEqual([]);
    expect(res.config?.plugins?.entries).toEqual({
      codex: { config: { supervision: { enabled: false, allowWriteControls: true } } },
    });
  });

  it("removes malformed legacy entries without creating Codex config", () => {
    const res = migrateLegacyConfigForTest({
      plugins: {
        entries: {
          "codex-supervisor": "invalid",
        },
      },
    });

    expect(res.config?.plugins?.entries).toEqual({});
    expect(res.changes).toContain("Removed invalid plugins.entries.codex-supervisor config.");
  });

  it("repairs policy-only references without creating a Codex entry", () => {
    const res = migrateLegacyConfigForTest({
      plugins: {
        allow: ["codex-supervisor", "codex"],
        deny: ["codex-supervisor"],
      },
    });

    expect(res.config?.plugins?.allow).toEqual(["codex"]);
    expect(res.config?.plugins?.deny).toEqual([]);
    expect(res.config?.plugins?.entries).toBeUndefined();
  });
});

describe("legacy bundled provider discovery migrate", () => {
  it("rewrites legacy OpenAI Codex plugin policy ids", () => {
    const res = migrateLegacyConfigForTest({
      plugins: {
        allow: ["telegram", "openai-codex", "openai"],
        deny: ["openai-codex"],
        entries: {
          "openai-codex": {
            enabled: false,
          },
        },
        slots: {
          memory: "openai-codex",
        },
      },
    });

    expect(res.config?.plugins?.allow).toEqual(["telegram", "openai"]);
    expect(res.config?.plugins?.deny).toEqual(["openai"]);
    expect(res.config?.plugins?.entries?.openai).toEqual({ enabled: false });
    expect(res.config?.plugins?.entries?.["openai-codex"]).toBeUndefined();
    expect(res.config?.plugins?.slots?.memory).toBe("openai");
    expect(res.changes).toContain("Rewrote plugins.allow openai-codex references to openai.");
    expect(res.changes).toContain("Rewrote plugins.deny openai-codex references to openai.");
    expect(res.changes).toContain(
      "Rewrote plugins.entries.openai-codex to plugins.entries.openai.",
    );
    expect(res.changes).toContain("Rewrote plugins.slots openai-codex references to openai.");
  });

  it("strips explicit bundled discovery mode after machine-state capture", () => {
    const res = migrateLegacyConfigForTest({
      plugins: {
        allow: ["telegram"],
        bundledDiscovery: "allowlist",
      },
    });

    expect(res.config).toEqual({ plugins: { allow: ["telegram"] } });
    expect(res.changes).toStrictEqual([
      "Applied tier-eval tranche retirements; canonical settings and built-in defaults now apply.",
    ]);
  });
});

describe("legacy migrate controlUi.allowedOrigins seed (issue #29385)", () => {
  it.each([
    {
      gateway: { bind: "custom", port: 9000, customBindHost: "192.168.1.100" },
      expected: {
        bind: "custom",
        port: 9000,
        customBindHost: "192.168.1.100",
        controlUi: {
          allowedOrigins: [
            "http://localhost:9000",
            "http://127.0.0.1:9000",
            "http://192.168.1.100:9000",
          ],
        },
      },
    },
    {
      gateway: { bind: "0.0.0.0", controlUi: { basePath: "/app", allowedOrigins: ["", "   "] } },
      expected: {
        bind: "lan",
        controlUi: {
          basePath: "/app",
          allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
        },
      },
    },
  ])(
    "seeds non-loopback origins while preserving gateway settings: $gateway.bind",
    ({ gateway, expected }) => {
      expect(migrateLegacyConfigForTest({ gateway }).config?.gateway).toEqual(expected);
    },
  );

  it.each([
    { allowedOrigins: ["https://control.example.com"] },
    { dangerouslyAllowHostHeaderOriginFallback: true },
  ])("preserves an explicit origin policy: %j", (controlUi) => {
    expect(migrateLegacyConfigForTest({ gateway: { bind: "lan", controlUi } })).toEqual({
      config: null,
      changes: [],
    });
  });

  it("does not seed allowedOrigins for loopback host aliases", () => {
    const res = migrateLegacyConfigForTest({ gateway: { bind: "localhost" } });
    expect(res.config?.gateway).toEqual({ bind: "loopback" });
    expect(res.changes).toEqual(['Normalized gateway.bind "localhost" → "loopback".']);
  });
});

describe("gateway.port out-of-range repair migrate", () => {
  it("removes a zero port and its empty gateway section", () => {
    const res = migrateLegacyConfigForTest({ gateway: { port: 0 } });
    expect(res.config).not.toHaveProperty("gateway");
    expect(res.changes).toEqual([expect.stringContaining("Removed out-of-range gateway.port (0)")]);
  });

  it("seeds non-loopback Control UI origins with the fallback port", () => {
    const res = migrateLegacyConfigForTest({
      gateway: { port: 65_536, bind: "lan" },
    });

    expect(res.config?.gateway).toMatchObject({
      bind: "lan",
      controlUi: {
        allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
      },
    });
  });
});

describe("legacy model compat migrate", () => {
  it("upgrades the retired xAI quality image slug without pinning active aliases", () => {
    const raw = {
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "xai/grok-imagine-image-pro",
            fallbacks: ["xai/grok-imagine-image"],
          },
          model: {
            primary: "xai/grok-4.20-beta-latest-reasoning",
          },
          models: {
            "xai/grok-imagine-image-pro": { alias: "quality" },
          },
        },
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain("agents");
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.agents?.defaults?.mediaModels?.image).toEqual({
      primary: "xai/grok-imagine-image-quality",
      fallbacks: ["xai/grok-imagine-image"],
    });
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "xai/grok-4.20-beta-latest-reasoning",
    });
    expect(res.config?.agents?.defaults?.models).toEqual({
      "xai/grok-imagine-image-quality": { alias: "quality" },
    });
  });

  it("upgrades retired model refs", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          workspace: "/tmp/claude-3-sonnet",
          imageModel: "anthropic/claude-haiku-4-5",
          imageGenerationModel: {
            primary: "github-copilot/claude-sonnet-4",
            fallbacks: ["github-copilot/grok-code-fast-1"],
          },
          musicGenerationModel: "vercel-ai-gateway/anthropic/claude-opus-4-5",
          pdfModel: "anthropic/claude-3-5-sonnet",
          videoGenerationModel: "anthropic/claude-opus-4-10",
          model: {
            primary: "anthropic/claude-opus-4-5@anthropic:work",
            fallbacks: [
              "anthropic/claude-sonnet-4-20250514",
              "github-copilot/claude-sonnet-4",
              "github-copilot/grok-code-fast-1@github:work",
              "venice/claude-opus-4-5",
              "vercel-ai-gateway/anthropic/claude-opus-4-5",
              "anthropic/claude-opus-5-0",
              "anthropic/claude-sonnet-4-7",
              "anthropic/claude-opus-4-10",
              "kilocode/anthropic/claude-sonnet-4",
              "amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
              "openai/gpt-5.5",
              "openai/gpt-4o",
              "openai/gpt-4.1-mini",
              "openai/gpt-5.1-codex-mini",
              "openai/gpt-5.2-codex",
              "openai-codex/gpt-5.2",
              "openai-codex/gpt-5.1-codex-mini",
              "github-copilot/gpt-4.1",
              "github-copilot/gpt-5.2",
              "github-copilot/gpt-5.2-codex",
              "groq/llama3-70b-8192",
              "groq/gemma2-9b-it",
              "groq/moonshotai/kimi-k2-instruct-0905",
              "xai/grok-code-fast-1",
              "xai/grok-4-fast-reasoning",
              "openai/gpt-4o-transcribe",
              "openai/gpt-4o-mini-tts",
              "openai/constructor",
            ],
          },
          models: {
            "anthropic/claude-haiku-4-5": { alias: "haiku" },
            "anthropic/claude-sonnet-4-6": { alias: "current-sonnet" },
            "github-copilot/claude-opus-4.5": { alias: "copilot-opus" },
            "openai/gpt-5.2-pro": { alias: "old-pro" },
            "github-copilot/gpt-5-mini": { alias: "old-mini" },
          },
        },
      },
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              summaryModel: "anthropic/claude-3-5-sonnet",
              dataPath: "/tmp/claude-opus-4-5",
            },
            subagent: {
              allowedModels: ["anthropic/claude-haiku-4-5", "*"],
            },
          },
        },
      },
      channels: {
        modelByChannel: {
          telegram: {
            "*": "anthropic/claude-opus-4-5",
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.imageModel).toBe("anthropic/claude-haiku-4-5");
    expect(res.config?.agents?.defaults?.mediaModels?.image).toEqual({
      primary: "github-copilot/claude-sonnet-4.6",
      fallbacks: ["github-copilot/gpt-5.4-mini"],
    });
    expect(res.config?.agents?.defaults?.mediaModels?.music).toBe(
      "vercel-ai-gateway/anthropic/claude-opus-4-6",
    );
    expect(res.config?.agents?.defaults?.pdfModel).toBe("anthropic/claude-sonnet-4-6");
    expect(res.config?.agents?.defaults?.mediaModels?.video).toBe("anthropic/claude-opus-4-10");
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-7@anthropic:work",
      fallbacks: [
        "anthropic/claude-sonnet-4-6",
        "github-copilot/claude-sonnet-4.6",
        "github-copilot/gpt-5.4-mini@github:work",
        "venice/claude-opus-4-6",
        "vercel-ai-gateway/anthropic/claude-opus-4-6",
        "anthropic/claude-opus-5-0",
        "anthropic/claude-sonnet-4-7",
        "anthropic/claude-opus-4-10",
        "kilocode/anthropic/claude-sonnet-4",
        "amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
        "openai/gpt-5.5",
        "openai/gpt-5.5",
        "openai/gpt-5.4-mini",
        "openai/gpt-5.4-mini",
        "openai/gpt-5.3-codex",
        "openai-codex/gpt-5.5",
        "openai-codex/gpt-5.4-mini",
        "github-copilot/gpt-5.5",
        "github-copilot/gpt-5.5",
        "github-copilot/gpt-5.3-codex",
        "groq/llama-3.3-70b-versatile",
        "groq/llama-3.1-8b-instant",
        "groq/openai/gpt-oss-120b",
        "xai/grok-build-0.1",
        "xai/grok-4.3",
        "openai/gpt-4o-transcribe",
        "openai/gpt-4o-mini-tts",
        "openai/constructor",
      ],
    });
    expect(res.config?.agents?.defaults?.workspace).toBe("/tmp/claude-3-sonnet");
    expect(res.config?.agents?.defaults?.models).toEqual({
      "anthropic/claude-haiku-4-5": { alias: "haiku" },
      "anthropic/claude-sonnet-4-6": { alias: "current-sonnet" },
      "github-copilot/claude-opus-4.7": { alias: "copilot-opus" },
      "openai/gpt-5.5-pro": { alias: "old-pro" },
      "github-copilot/gpt-5.4-mini": { alias: "old-mini" },
    });
    expect(res.config).toHaveProperty("plugins.entries.lossless-claw.config", {
      summaryModel: "anthropic/claude-sonnet-4-6",
      dataPath: "/tmp/claude-opus-4-5",
    });
    expect(res.config).toHaveProperty("plugins.entries.lossless-claw.subagent.allowedModels", [
      "anthropic/claude-haiku-4-5",
      "*",
    ]);
    expect(res.config?.channels?.modelByChannel?.telegram?.["*"]).toBe("anthropic/claude-opus-4-7");
  });

  it("normalizes persisted model aliases across nested selections and provider catalogs", () => {
    const retired = "google/gemini-3-pro-preview";
    const canonical = "google/gemini-3.1-pro-preview";
    const raw = {
      agents: {
        defaults: {
          model: retired,
          utilityModel: retired,
          imageModel: retired,
          voiceModel: retired,
          pdfModel: retired,
          mediaModels: {
            image: retired,
            video: { primary: retired, fallbacks: [retired] },
            music: retired,
          },
          heartbeat: { model: retired },
          subagents: { model: { primary: retired, fallbacks: [retired] } },
          compaction: { model: retired, memoryFlush: { model: retired } },
          models: { [retired]: { alias: "Gemini" } },
        },
        entries: {
          ops: {
            model: retired,
            utilityModel: retired,
            heartbeat: { model: retired },
            subagents: { model: retired },
            models: { [retired]: { alias: "Ops Gemini" } },
          },
        },
      },
      models: {
        providers: {
          google: { models: [{ id: "gemini-3-pro-preview", name: "Gemini" }] },
          myproxy: {
            models: [{ id: "google/gemini-3-pro-preview", name: "Gemini proxy" }],
          },
          openai: { models: [{ id: "gpt-4o", name: "GPT-4o" }] },
        },
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["agents", "models"]),
    );
    const res = migrateLegacyConfigForTest(raw);
    const defaults = res.config?.agents?.defaults;
    expect(defaults).toMatchObject({
      model: canonical,
      utilityModel: canonical,
      imageModel: canonical,
      voiceModel: canonical,
      pdfModel: canonical,
      mediaModels: {
        image: canonical,
        video: { primary: canonical, fallbacks: [canonical] },
        music: canonical,
      },
      heartbeat: { model: canonical },
      subagents: { model: { primary: canonical, fallbacks: [canonical] } },
      compaction: { model: canonical, memoryFlush: { model: canonical } },
      models: { [canonical]: { alias: "Gemini" } },
    });
    expect(res.config?.agents?.entries?.ops).toMatchObject({
      model: canonical,
      utilityModel: canonical,
      heartbeat: { model: canonical },
      subagents: { model: canonical },
      models: { [canonical]: { alias: "Ops Gemini" } },
    });
    expect(res.config?.models?.providers?.google?.models?.[0]?.id).toBe("gemini-3.1-pro-preview");
    expect(res.config?.models?.providers?.myproxy?.models?.[0]?.id).toBe(canonical);
    expect(res.config?.models?.providers?.openai?.models?.[0]?.id).toBe("gpt-5.5");
  });

  it("canonicalizes persisted OpenAI GPT-5.6 aliases without affecting GitHub Copilot", () => {
    const copilot = "github-copilot/gpt-5.6";
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6@openai:work" },
          modelPolicy: { allow: ["openai/gpt-5.6", copilot] },
          models: {
            "openai/gpt-5.6": { alias: "GPT" },
            "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            [copilot]: { alias: "Copilot GPT" },
          },
        },
      },
      models: {
        providers: {
          openai: { models: [{ id: "gpt-5.6", name: "GPT alias" }] },
          "github-copilot": { models: [{ id: "gpt-5.6", name: "Copilot GPT" }] },
        },
      },
    });
    const defaults = res.config?.agents?.defaults;
    expect(defaults).toMatchObject({
      model: { primary: "openai/gpt-5.6-sol@openai:work" },
      modelPolicy: { allow: ["openai/gpt-5.6-sol", copilot] },
    });
    expect(defaults?.models).toEqual({
      "openai/gpt-5.6-sol": { alias: "GPT", agentRuntime: { id: "openclaw" } },
      [copilot]: { alias: "Copilot GPT" },
    });
    expect(res.config?.models?.providers?.openai?.models?.[0]?.id).toBe("gpt-5.6-sol");
    expect(res.config?.models?.providers?.["github-copilot"]?.models?.[0]?.id).toBe("gpt-5.6");
  });

  it("merges provider catalog rows that normalize to an explicitly canonical id", () => {
    const res = migrateLegacyConfigForTest({
      models: {
        providers: {
          google: {
            models: [
              {
                id: "gemini-3-pro-preview",
                name: "Retired alias",
                maxTokens: 65_536,
                cost: { input: 1 },
              },
              {
                id: "gemini-3.1-pro-preview",
                name: "Canonical",
                cost: { output: 2 },
              },
            ],
          },
        },
      },
    });

    expect(res.config?.models?.providers?.google?.models).toEqual([
      {
        id: "gemini-3.1-pro-preview",
        name: "Canonical",
        maxTokens: 65_536,
        cost: { output: 2, input: 1 },
      },
    ]);
    expect(res.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Merged config.models.providers.google.models.0 into model id "gemini-3.1-pro-preview"; kept canonical values for conflicting fields: name.',
        ),
      ]),
    );
  });

  it("deep-merges colliding retired model refs and reports only unequal fields", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o": {
              params: {
                reasoning: { effort: "high", budget: 100 },
                tags: ["stable"],
                fallbacks: ["openai/gpt-4"],
              },
              streaming: false,
            },
            "openai/gpt-4": {
              params: {
                reasoning: { effort: "low", summary: "auto" },
                tags: ["stable"],
                fallbacks: ["openai/gpt-5.5"],
              },
              alias: "legacy-four",
            },
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": {
        params: {
          reasoning: { effort: "high", budget: 100, summary: "auto" },
          tags: ["stable"],
          fallbacks: ["openai/gpt-5.5"],
        },
        streaming: false,
        alias: "legacy-four",
      },
    });
    expect(res.changes.filter((change) => change.includes("Merged"))).toEqual([
      'Merged config.agents.defaults.models key "openai/gpt-4" into "openai/gpt-5.5"; kept existing values for conflicting fields: params.reasoning.effort.',
    ]);
  });

  it("keeps canonical values when the canonical model key appears last", () => {
    const canonical = [
      "openai/gpt-5.5",
      {
        alias: "canonical-five",
        params: { reasoning: { effort: "medium", canonicalOnly: true } },
        agentRuntime: { id: "codex" },
      },
    ] as const;
    const retired = [
      [
        "openai/gpt-4",
        {
          alias: "legacy-four",
          params: { reasoning: { effort: "low", fourOnly: true } },
        },
      ],
      [
        "openai/gpt-4o",
        {
          streaming: false,
          params: { reasoning: { effort: "high", fourOOnly: true } },
        },
      ],
    ] as const;
    const res = migrateLegacyConfigForTest({
      agents: { defaults: { models: Object.fromEntries([...retired, canonical]) } },
    });

    expect(res.config?.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": {
        alias: "canonical-five",
        params: {
          reasoning: {
            effort: "medium",
            canonicalOnly: true,
            fourOnly: true,
            fourOOnly: true,
          },
        },
        agentRuntime: { id: "codex" },
        streaming: false,
      },
    });
    expect(res.changes.filter((change) => change.includes("Merged"))).toEqual([
      'Merged config.agents.defaults.models key "openai/gpt-4" into "openai/gpt-5.5"; kept existing values for conflicting fields: alias, params.reasoning.effort.',
      'Merged config.agents.defaults.models key "openai/gpt-4o" into "openai/gpt-5.5"; kept existing values for conflicting fields: params.reasoning.effort.',
    ]);
  });

  it("filters blocked keys recursively from both model collision sides", () => {
    const raw =
      '{"agents":{"defaults":{"models":{"openai/gpt-5.5":{"__proto__":{"polluted":true},"alias":"canonical-five","params":{"nested":{"__proto__":{"polluted":true},"model":"openai/gpt-4o"}}},"openai/gpt-4":{"alias":"legacy-four","__proto__":{"polluted":true},"streaming":false,"params":{"nested":{"__proto__":{"polluted":true},"added":true}}}}}}}';
    const res = migrateLegacyConfigForTest(JSON.parse(raw));
    const merged = res.config?.agents?.defaults?.models?.["openai/gpt-5.5"] as Record<
      string,
      unknown
    >;
    const params = merged.params as Record<string, unknown>;
    const nested = params.nested as Record<string, unknown>;

    for (const record of [merged, params, nested]) {
      expect(Object.getOwnPropertyNames(record)).not.toContain("__proto__");
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
      expect(record.polluted).toBeUndefined();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(merged).toEqual({
      alias: "canonical-five",
      params: { nested: { model: "openai/gpt-5.5", added: true } },
      streaming: false,
    });
  });

  it("does not invoke prototype setters when copying the rewritten config root", () => {
    const raw = JSON.parse(
      '{"__proto__":{"polluted":true},"agents":{"defaults":{"model":"openai/gpt-4"}}}',
    ) as Record<string, unknown>;
    const res = migrateLegacyConfigForTest(raw);
    const config = res.config as unknown as Record<string, unknown>;

    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
    expect(Object.hasOwn(config, "__proto__")).toBe(true);
    expect(config.polluted).toBeUndefined();
    expect(res.config?.agents?.defaults?.model).toBe("openai/gpt-5.5");
  });

  it("reports malformed scalar collisions without claiming equal values conflict", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": false,
            "openai/gpt-4": true,
            "openai/gpt-4o": false,
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.models?.["openai/gpt-5.5"]).toBe(false);
    expect(res.changes.filter((change) => change.includes("Merged"))).toEqual([
      'Merged config.agents.defaults.models key "openai/gpt-4" into "openai/gpt-5.5"; kept existing values for conflicting fields: value.',
      'Merged config.agents.defaults.models key "openai/gpt-4o" into "openai/gpt-5.5".',
    ]);
  });

  it("moves Qwen model-map and model-row params while preserving canonical compat", () => {
    const raw = {
      agents: {
        defaults: {
          models: {
            "VLLM/Qwen/new@local": { params: { qwen_thinking_format: "enable_thinking" } },
            "vllm/Qwen/existing": {
              params: { qwenThinkingFormat: "chat-template", temperature: 0.2 },
            },
            "vllm/Qwen/kept": { params: { qwenThinkingFormat: "top-level" } },
          },
        },
      },
      models: {
        providers: {
          VLLM: {
            models: [
              { id: "vllm/Qwen/existing", name: "Existing" },
              { id: "Qwen/kept", compat: { thinkingFormat: "qwen-chat-template" } },
              { id: "Qwen/row", params: { qwenThinkingFormat: "chat-template", temperature: 0.2 } },
            ],
          },
        },
      },
    };
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["agents.defaults.models", "models.providers"]),
    );
    const res = migrateLegacyConfigForTest(raw);
    expect(res.config?.models?.providers?.vllm).toBeUndefined();
    expect(res.config?.models?.providers?.VLLM?.models).toEqual([
      {
        id: "vllm/Qwen/existing",
        name: "Existing",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
      { id: "Qwen/kept", reasoning: true, compat: { thinkingFormat: "qwen-chat-template" } },
      {
        id: "Qwen/row",
        reasoning: true,
        params: { temperature: 0.2 },
        compat: { thinkingFormat: "qwen-chat-template" },
      },
      { id: "Qwen/new", name: "Qwen/new", reasoning: true, compat: { thinkingFormat: "qwen" } },
    ]);
    expect(res.config?.agents?.defaults?.models).toEqual({
      "VLLM/Qwen/new@local": {},
      "vllm/Qwen/existing": { params: { temperature: 0.2 } },
      "vllm/Qwen/kept": {},
    });
  });

  it("preserves vLLM target order and cached formats across provider, default, and agent params", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: { primary: "vllm/Qwen/Qwen3-8B", fallbacks: ["vllm/Qwen/Qwen3-14B"] },
          params: { qwenThinkingFormat: "chat-template" },
        },
        entries: {
          worker: {
            model: {
              primary: "vllm/Qwen/Qwen3-14B",
              fallbacks: ["vllm/Qwen/Qwen3-8B", "vllm/Qwen/Qwen3-32B"],
            },
            params: { qwen_thinking_format: "invalid" },
          },
        },
      },
      models: {
        providers: {
          vllm: {
            params: { qwenThinkingFormat: "enable-thinking" },
            models: [
              {
                id: "Qwen/Qwen3-8B",
                reasoning: false,
                compat: { thinkingFormat: "qwen-chat-template" },
              },
              { id: "Qwen/Qwen3-14B" },
            ],
          },
        },
      },
    });

    expect(res.config?.models?.providers?.vllm).toEqual({
      models: [
        {
          id: "Qwen/Qwen3-8B",
          reasoning: false,
          compat: { thinkingFormat: "qwen-chat-template" },
        },
        { id: "Qwen/Qwen3-14B", reasoning: true, compat: { thinkingFormat: "qwen" } },
        {
          id: "Qwen/Qwen3-32B",
          name: "Qwen/Qwen3-32B",
          reasoning: true,
          compat: { thinkingFormat: "qwen" },
        },
      ],
    });
    expect(res.config?.agents?.defaults).toEqual({
      model: { primary: "vllm/Qwen/Qwen3-8B", fallbacks: ["vllm/Qwen/Qwen3-14B"] },
    });
    expect(res.config?.agents?.entries?.worker).toEqual({
      model: {
        primary: "vllm/Qwen/Qwen3-14B",
        fallbacks: ["vllm/Qwen/Qwen3-8B", "vllm/Qwen/Qwen3-32B"],
      },
    });
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
  });

  it("creates absent provider ancestors for selected and inherited Qwen params", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: "vllm/Qwen/selected@local",
          params: { qwenThinkingFormat: "chat-template", temperature: 0.2 },
        },
        list: [{ id: "local", params: { qwenThinkingFormat: "chat-template" } }],
      },
    });
    expect(res.config?.models?.providers?.vllm).toEqual({
      models: [
        {
          id: "Qwen/selected",
          name: "Qwen/selected",
          reasoning: true,
          compat: { thinkingFormat: "qwen-chat-template" },
        },
      ],
    });
    expect(res.config?.agents?.defaults?.params).toEqual({ temperature: 0.2 });
    expect(res.config?.agents?.list?.[0]).toEqual({ id: "local" });
  });

  it("removes untargeted Qwen params from provider, default, and agent scopes", () => {
    const raw = {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://localhost:8000/v1",
            params: { qwenThinkingFormat: "chat-template", temperature: 0.2 },
          },
        },
      },
      agents: {
        defaults: { params: { qwenThinkingFormat: "chat-template", temperature: 0.3 } },
        list: [
          { id: "local", params: { qwen_thinking_format: "enable_thinking", temperature: 0.4 } },
        ],
      },
    };
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["models.providers.vllm.params", "agents.defaults.params", "agents"]),
    );
    const res = migrateLegacyConfigForTest(raw);
    expect(res.config?.models?.providers?.vllm).toEqual({
      baseUrl: "http://localhost:8000/v1",
      params: { temperature: 0.2 },
    });
    expect(res.config?.agents?.defaults?.params).toEqual({ temperature: 0.3 });
    expect(res.config?.agents?.list?.[0]).toEqual({ id: "local", params: { temperature: 0.4 } });
    expect(res.changes).toEqual([
      expect.stringContaining(
        "Removed models.providers.vllm.params.qwenThinkingFormat; no concrete vLLM model",
      ),
      expect.stringContaining(
        "Removed agents.defaults.params.qwenThinkingFormat; no concrete vLLM model",
      ),
      expect.stringContaining(
        "Removed agents.list[0].params.qwen_thinking_format; no concrete vLLM model",
      ),
    ]);
  });

  it.each(["malformed", { models: "malformed" }])(
    "preserves Qwen params when their destination cannot be written: %j",
    (vllm) => {
      const res = migrateLegacyConfigForTest({
        agents: {
          defaults: {
            models: { "vllm/Qwen/model": { params: { qwenThinkingFormat: "chat-template" } } },
          },
        },
        models: { providers: { vllm } },
      });
      expect(res.config?.models?.providers?.vllm).toEqual(vllm);
      expect(res.config?.agents?.defaults?.models).toEqual({
        "vllm/Qwen/model": { params: { qwenThinkingFormat: "chat-template" } },
      });
      expect(res.changes).toEqual([
        "Copied the legacy default model map to agents.defaults.modelPolicy.allow.",
      ]);
    },
  );

  it("removes only invalid thinking formats across provider catalogs", () => {
    const res = migrateLegacyConfigForTest({
      models: {
        providers: {
          bailian: {
            models: [
              { id: "valid", compat: { thinkingFormat: "qwen-chat-template" } },
              { id: "legacy", compat: { thinkingFormat: "old-bailian", supportsTools: true } },
            ],
          },
          openrouter: {
            models: [{ id: "legacy-router", compat: { thinkingFormat: "openrouter-v0" } }],
          },
        },
      },
    });
    expect(res.config?.models?.providers?.bailian?.models).toEqual([
      { id: "valid", compat: { thinkingFormat: "qwen-chat-template" } },
      { id: "legacy", compat: { supportsTools: true } },
    ]);
    expect(res.config?.models?.providers?.openrouter?.models).toEqual([
      { id: "legacy-router", compat: {} },
    ]);
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
  });
});

describe("legacy memory search config migrate", () => {
  it("merges legacy defaults before normalizing memory search fields", () => {
    const raw = {
      memorySearch: {
        enabled: true,
        provider: "auto",
        model: "text-embedding-3-small",
        chunkSize: 800,
        chunkOverlap: 100,
        maxResults: 5,
        store: { path: "/tmp/root-memory.sqlite", vector: { enabled: false } },
      },
      agents: {
        defaults: {
          memorySearch: {
            chunking: { tokens: 1200 },
            query: { maxResults: 9 },
            store: { path: "/tmp/default-memory.sqlite", fts: { tokenizer: "trigram" } },
          },
        },
      },
    };
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "memorySearch",
        "memorySearch.provider",
        "agents.defaults.memorySearch",
      ]),
    );
    const res = migrateLegacyConfigForTest(raw);
    expect(res.config).not.toHaveProperty("memorySearch");
    expect(res.config?.memory?.search).toEqual({
      enabled: true,
      provider: "openai",
      model: "text-embedding-3-small",
      query: { maxResults: 9 },
      store: { fts: { tokenizer: "trigram" }, vector: { enabled: false } },
    });
    expect(res.changes).toEqual(
      expect.arrayContaining([
        "Removed memory.search.chunkSize (memory.search.chunking.tokens already set).",
        "Moved memory.search.chunkOverlap → memory.search.chunking.overlap.",
        "Removed memory.search.maxResults (memory.search.query.maxResults already set).",
        "Removed memory.search.store.path; memory indexes now use each agent database.",
      ]),
    );
  });

  it("normalizes per-agent memory search independently and removes empty retired settings", () => {
    const raw = {
      agents: {
        defaults: {
          memorySearch: { provider: "auto", chunkSize: 800, chunkOverlap: 100, maxResults: 5 },
        },
        list: [
          {
            id: "local",
            memorySearch: {
              provider: " auto ",
              chunkSize: 500,
              store: { path: "/tmp/ops-memory.sqlite", vector: { enabled: true } },
            },
          },
          {
            id: "custom",
            memorySearch: { provider: "openai-compatible", chunkOverlap: 50, maxResults: 10 },
          },
          { id: "retired", memorySearch: { chunkSize: 500 } },
        ],
      },
    };
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["agents.defaults.memorySearch", "agents", "agents.list"]),
    );
    const res = migrateLegacyConfigForTest(raw);
    expect(res.config?.memory?.search).toEqual({ provider: "openai", query: { maxResults: 5 } });
    expect(res.config?.agents?.list?.[0]?.memory?.search).toEqual({
      provider: "openai",
      store: { vector: { enabled: true } },
    });
    expect(res.config?.agents?.list?.[1]?.memory?.search).toEqual({
      provider: "openai-compatible",
      query: { maxResults: 10 },
    });
    expect(res.config?.agents?.list?.[2]?.memory?.search).toBeUndefined();
    expect(res.changes).toContain(
      "Removed agents.list[0].memory.search.store.path; memory indexes now use each agent database.",
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
