import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import { parseInlineDirectives } from "./directive-handling.js";
import {
  maybeHandleModelDirectiveInfo,
  resolveModelSelectionFromDirective,
} from "./directive-handling.model.js";
import { persistInlineDirectives } from "./directive-handling.persist.js";

// Mock dependencies for directive handling persistence.
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

const TEST_AGENT_DIR = "/tmp/agent";

function baseAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

function baseConfig(): OpenClawConfig {
  return {
    commands: { text: true },
    agents: { defaults: {} },
  } as unknown as OpenClawConfig;
}

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir: TEST_AGENT_DIR,
      store: { version: 1, profiles: {} },
    },
  ]);
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
});

function setAuthProfiles(
  profiles: Record<string, { type: "api_key"; provider: string; key: string }>,
) {
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir: TEST_AGENT_DIR,
      store: { version: 1, profiles },
    },
  ]);
}

function resolveModelSelectionForCommand(params: {
  command: string;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: Array<{ provider: string; id: string }>;
}) {
  return resolveModelSelectionFromDirective({
    directives: parseInlineDirectives(params.command),
    cfg: { commands: { text: true } } as unknown as OpenClawConfig,
    agentDir: TEST_AGENT_DIR,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-5",
    aliasIndex: baseAliasIndex(),
    allowedModelKeys: params.allowedModelKeys,
    allowedModelCatalog: params.allowedModelCatalog,
    provider: "anthropic",
  });
}

async function resolveModelInfoReply(
  overrides: Partial<Parameters<typeof maybeHandleModelDirectiveInfo>[0]> = {},
) {
  return maybeHandleModelDirectiveInfo({
    directives: parseInlineDirectives("/model"),
    cfg: baseConfig(),
    agentDir: TEST_AGENT_DIR,
    activeAgentId: "main",
    provider: "anthropic",
    model: "claude-opus-4-5",
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-5",
    aliasIndex: baseAliasIndex(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    ...overrides,
  });
}

describe("/model chat UX", () => {
  it("shows summary for /model with no args", async () => {
    const reply = await resolveModelInfoReply();

    expect(reply?.text).toContain("Current:");
    expect(reply?.text).toContain("Browse: /models");
    expect(reply?.text).toContain("Switch: /model <provider/model>");
  });

  it("shows active runtime model when different from selected model", async () => {
    const reply = await resolveModelInfoReply({
      provider: "fireworks",
      model: "fireworks/minimax-m2p5",
      defaultProvider: "fireworks",
      defaultModel: "fireworks/minimax-m2p5",
      sessionEntry: {
        modelProvider: "deepinfra",
        model: "moonshotai/Kimi-K2.5",
      },
    });

    expect(reply?.text).toContain("Current: fireworks/minimax-m2p5 (selected)");
    expect(reply?.text).toContain("Active: deepinfra/moonshotai/Kimi-K2.5 (runtime)");
  });

  it("auto-applies closest match for typos", () => {
    const directives = parseInlineDirectives("/model anthropic/claud-opus-4-5");
    const cfg = { commands: { text: true } } as unknown as OpenClawConfig;

    const resolved = resolveModelSelectionFromDirective({
      directives,
      cfg,
      agentDir: "/tmp/agent",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys: new Set(["anthropic/claude-opus-4-5"]),
      allowedModelCatalog: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      provider: "anthropic",
    });

    expect(resolved.modelSelection).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
      isDefault: true,
    });
    expect(resolved.errorText).toBeUndefined();
  });

  it("rejects numeric /model selections with a guided error", () => {
    const resolved = resolveModelSelectionForCommand({
      command: "/model 99",
      allowedModelKeys: new Set(["anthropic/claude-opus-4-5", "openai/gpt-4o"]),
      allowedModelCatalog: [],
    });

    expect(resolved.modelSelection).toBeUndefined();
    expect(resolved.errorText).toContain("Numeric model selection is not supported in chat.");
    expect(resolved.errorText).toContain("Browse: /models or /models <provider>");
  });

  it("treats explicit default /model selection as resettable default", () => {
    const resolved = resolveModelSelectionForCommand({
      command: "/model anthropic/claude-opus-4-5",
      allowedModelKeys: new Set(["anthropic/claude-opus-4-5", "openai/gpt-4o"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
      isDefault: true,
    });
  });

  it("keeps openrouter provider/model split for exact selections", () => {
    const resolved = resolveModelSelectionForCommand({
      command: "/model openrouter/anthropic/claude-opus-4-5",
      allowedModelKeys: new Set(["openrouter/anthropic/claude-opus-4-5"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-opus-4-5",
      isDefault: false,
    });
  });

  it("keeps cloudflare @cf model segments for exact selections", () => {
    const resolved = resolveModelSelectionForCommand({
      command: "/model openai/@cf/openai/gpt-oss-20b",
      allowedModelKeys: new Set(["openai/@cf/openai/gpt-oss-20b"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "openai",
      model: "@cf/openai/gpt-oss-20b",
      isDefault: false,
    });
  });

  it("treats @YYYYMMDD as a profile override when that profile exists for the resolved provider", () => {
    setAuthProfiles({
      "20251001": {
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      },
    });

    const resolved = resolveModelSelectionForCommand({
      command: "/model openai/gpt-4o@20251001",
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "openai",
      model: "gpt-4o",
      isDefault: false,
    });
    expect(resolved.profileOverride).toBe("20251001");
  });

  it("supports alias selections with numeric auth-profile overrides", () => {
    setAuthProfiles({
      "20251001": {
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      },
    });

    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([["gpt", { alias: "gpt", ref: { provider: "openai", model: "gpt-4o" } }]]),
      byKey: new Map([["openai/gpt-4o", ["gpt"]]]),
    };

    const resolved = resolveModelSelectionFromDirective({
      directives: parseInlineDirectives("/model gpt@20251001"),
      cfg: { commands: { text: true } } as unknown as OpenClawConfig,
      agentDir: "/tmp/agent",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex,
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      allowedModelCatalog: [],
      provider: "anthropic",
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "openai",
      model: "gpt-4o",
      isDefault: false,
      alias: "gpt",
    });
    expect(resolved.profileOverride).toBe("20251001");
  });

  it("supports providerless allowlist selections with numeric auth-profile overrides", () => {
    setAuthProfiles({
      "20251001": {
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      },
    });

    const resolved = resolveModelSelectionForCommand({
      command: "/model gpt-4o@20251001",
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "openai",
      model: "gpt-4o",
      isDefault: false,
    });
    expect(resolved.profileOverride).toBe("20251001");
  });

  it("keeps @YYYYMMDD as part of the model when the stored numeric profile is for another provider", () => {
    setAuthProfiles({
      "20251001": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-test",
      },
    });

    const resolved = resolveModelSelectionForCommand({
      command: "/model custom/vertex-ai_claude-haiku-4-5@20251001",
      allowedModelKeys: new Set(["custom/vertex-ai_claude-haiku-4-5@20251001"]),
      allowedModelCatalog: [],
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "custom",
      model: "vertex-ai_claude-haiku-4-5@20251001",
      isDefault: false,
    });
    expect(resolved.profileOverride).toBeUndefined();
  });

  it("persists inferred numeric auth-profile overrides for mixed-content messages", async () => {
    setAuthProfiles({
      "20251001": {
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      },
    });

    const directives = parseInlineDirectives("/model openai/gpt-4o@20251001 hello");
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    } as SessionEntry;
    const sessionStore = { "agent:main:dm:1": sessionEntry };

    await persistInlineDirectives({
      directives,
      effectiveModelDirective: directives.rawModelDirective,
      cfg: baseConfig(),
      agentDir: TEST_AGENT_DIR,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys: new Set(["openai/gpt-4o", "openai/gpt-4o@20251001"]),
      provider: "anthropic",
      model: "claude-opus-4-5",
      initialModelLabel: "anthropic/claude-opus-4-5",
      formatModelSwitchEvent: (label) => label,
      agentCfg: baseConfig().agents?.defaults,
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe("20251001");
  });

  it("persists alias-based numeric auth-profile overrides for mixed-content messages", async () => {
    setAuthProfiles({
      "20251001": {
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      },
    });

    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([["gpt", { alias: "gpt", ref: { provider: "openai", model: "gpt-4o" } }]]),
      byKey: new Map([["openai/gpt-4o", ["gpt"]]]),
    };
    const directives = parseInlineDirectives("/model gpt@20251001 hello");
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    } as SessionEntry;
    const sessionStore = { "agent:main:dm:1": sessionEntry };

    await persistInlineDirectives({
      directives,
      effectiveModelDirective: directives.rawModelDirective,
      cfg: baseConfig(),
      agentDir: TEST_AGENT_DIR,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex,
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      provider: "anthropic",
      model: "claude-opus-4-5",
      initialModelLabel: "anthropic/claude-opus-4-5",
      formatModelSwitchEvent: (label) => label,
      agentCfg: baseConfig().agents?.defaults,
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe("20251001");
  });

  it("persists providerless numeric auth-profile overrides for mixed-content messages", async () => {
    setAuthProfiles({
      "20251001": {
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      },
    });

    const directives = parseInlineDirectives("/model gpt-4o@20251001 hello");
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    } as SessionEntry;
    const sessionStore = { "agent:main:dm:1": sessionEntry };

    await persistInlineDirectives({
      directives,
      effectiveModelDirective: directives.rawModelDirective,
      cfg: baseConfig(),
      agentDir: TEST_AGENT_DIR,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      provider: "anthropic",
      model: "claude-opus-4-5",
      initialModelLabel: "anthropic/claude-opus-4-5",
      formatModelSwitchEvent: (label) => label,
      agentCfg: baseConfig().agents?.defaults,
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe("20251001");
  });

  it("persists explicit auth profiles after @YYYYMMDD version suffixes in mixed-content messages", async () => {
    setAuthProfiles({
      work: {
        type: "api_key",
        provider: "custom",
        key: "sk-test",
      },
    });

    const directives = parseInlineDirectives(
      "/model custom/vertex-ai_claude-haiku-4-5@20251001@work hello",
    );
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    } as SessionEntry;
    const sessionStore = { "agent:main:dm:1": sessionEntry };

    await persistInlineDirectives({
      directives,
      effectiveModelDirective: directives.rawModelDirective,
      cfg: baseConfig(),
      agentDir: TEST_AGENT_DIR,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys: new Set(["custom/vertex-ai_claude-haiku-4-5@20251001"]),
      provider: "anthropic",
      model: "claude-opus-4-5",
      initialModelLabel: "anthropic/claude-opus-4-5",
      formatModelSwitchEvent: (label) => label,
      agentCfg: baseConfig().agents?.defaults,
    });

    expect(sessionEntry.providerOverride).toBe("custom");
    expect(sessionEntry.modelOverride).toBe("vertex-ai_claude-haiku-4-5@20251001");
    expect(sessionEntry.authProfileOverride).toBe("work");
  });

  it("ignores invalid mixed-content model directives during persistence", async () => {
    setAuthProfiles({
      "20251001": {
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      },
    });

    const directives = parseInlineDirectives("/model 99 hello");
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      authProfileOverride: "20251001",
      authProfileOverrideSource: "user",
    } as SessionEntry;
    const sessionStore = { "agent:main:dm:1": sessionEntry };

    const persisted = await persistInlineDirectives({
      directives,
      effectiveModelDirective: directives.rawModelDirective,
      cfg: baseConfig(),
      agentDir: TEST_AGENT_DIR,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys: new Set(["openai/gpt-4o"]),
      provider: "openai",
      model: "gpt-4o",
      initialModelLabel: "openai/gpt-4o",
      formatModelSwitchEvent: (label) => label,
      agentCfg: baseConfig().agents?.defaults,
    });

    expect(persisted.provider).toBe("openai");
    expect(persisted.model).toBe("gpt-4o");
    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe("20251001");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
  });
});

describe("handleDirectiveOnly model persist behavior (fixes #1435)", () => {
  const allowedModelKeys = new Set(["anthropic/claude-opus-4-5", "openai/gpt-4o"]);
  const allowedModelCatalog = [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  ];
  const sessionKey = "agent:main:dm:1";
  const storePath = "/tmp/sessions.json";

  type HandleParams = Parameters<typeof handleDirectiveOnly>[0];

  function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
    return {
      sessionId: "s1",
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  function createHandleParams(overrides: Partial<HandleParams>): HandleParams {
    const entryOverride = overrides.sessionEntry;
    const storeOverride = overrides.sessionStore;
    const entry = entryOverride ?? createSessionEntry();
    const store = storeOverride ?? ({ [sessionKey]: entry } as const);
    const { sessionEntry: _ignoredEntry, sessionStore: _ignoredStore, ...rest } = overrides;

    return {
      cfg: baseConfig(),
      directives: rest.directives ?? parseInlineDirectives(""),
      sessionKey,
      storePath,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys,
      allowedModelCatalog,
      resetModelOverride: false,
      provider: "anthropic",
      model: "claude-opus-4-5",
      initialModelLabel: "anthropic/claude-opus-4-5",
      formatModelSwitchEvent: (label) => `Switched to ${label}`,
      ...rest,
      sessionEntry: entry,
      sessionStore: store,
    };
  }

  it("shows success message when session state is available", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const sessionEntry = createSessionEntry();
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(result?.text).toContain("Model set to");
    expect(result?.text).toContain("openai/gpt-4o");
    expect(result?.text).not.toContain("failed");
  });

  it("shows no model message when no /model directive", async () => {
    const directives = parseInlineDirectives("hello world");
    const sessionEntry = createSessionEntry();
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(result?.text ?? "").not.toContain("Model set to");
    expect(result?.text ?? "").not.toContain("failed");
  });

  it("persists thinkingLevel=off (does not clear)", async () => {
    const directives = parseInlineDirectives("/think off");
    const sessionEntry = createSessionEntry({ thinkingLevel: "low" });
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
      }),
    );

    expect(result?.text ?? "").not.toContain("failed");
    expect(sessionEntry.thinkingLevel).toBe("off");
    expect(sessionStore["agent:main:dm:1"]?.thinkingLevel).toBe("off");
  });

  it("blocks internal operator.write exec persistence in directive-only handling", async () => {
    const directives = parseInlineDirectives(
      "/exec host=node security=allowlist ask=always node=worker-1",
    );
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
        surface: "webchat",
        gatewayClientScopes: ["operator.write"],
      }),
    );

    expect(result?.text).toContain("operator.admin");
    expect(sessionEntry.execHost).toBeUndefined();
    expect(sessionEntry.execSecurity).toBeUndefined();
    expect(sessionEntry.execAsk).toBeUndefined();
    expect(sessionEntry.execNode).toBeUndefined();
  });

  it("allows internal operator.admin exec persistence in directive-only handling", async () => {
    const directives = parseInlineDirectives(
      "/exec host=node security=allowlist ask=always node=worker-1",
    );
    const sessionEntry = createSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
        surface: "webchat",
        gatewayClientScopes: ["operator.admin"],
      }),
    );

    expect(result?.text).toContain("Exec defaults set");
    expect(sessionEntry.execHost).toBe("node");
    expect(sessionEntry.execSecurity).toBe("allowlist");
    expect(sessionEntry.execAsk).toBe("always");
    expect(sessionEntry.execNode).toBe("worker-1");
  });
});

describe("persistInlineDirectives internal exec scope gate", () => {
  it("skips exec persistence for internal operator.write callers", async () => {
    const allowedModelKeys = new Set(["anthropic/claude-opus-4-5", "openai/gpt-4o"]);
    const directives = parseInlineDirectives(
      "/exec host=node security=allowlist ask=always node=worker-1",
    );
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    } as SessionEntry;
    const sessionStore = { "agent:main:main": sessionEntry };

    await persistInlineDirectives({
      directives,
      cfg: baseConfig(),
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
      elevatedEnabled: true,
      elevatedAllowed: true,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys,
      provider: "anthropic",
      model: "claude-opus-4-5",
      initialModelLabel: "anthropic/claude-opus-4-5",
      formatModelSwitchEvent: (label) => `Switched to ${label}`,
      agentCfg: undefined,
      surface: "webchat",
      gatewayClientScopes: ["operator.write"],
    });

    expect(sessionEntry.execHost).toBeUndefined();
    expect(sessionEntry.execSecurity).toBeUndefined();
    expect(sessionEntry.execAsk).toBeUndefined();
    expect(sessionEntry.execNode).toBeUndefined();
  });
});
