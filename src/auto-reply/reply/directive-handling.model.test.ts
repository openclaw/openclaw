import { describe, expect, it, vi } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import { parseInlineDirectives } from "./directive-handling.js";
import {
  maybeHandleModelDirectiveInfo,
  resolveModelSelectionFromDirective,
} from "./directive-handling.model.js";

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

function baseAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

function baseConfig(): OpenClawConfig {
  return {
    commands: { text: true },
    agents: { defaults: {} },
  } as unknown as OpenClawConfig;
}

function resolveModelSelectionForCommand(params: {
  command: string;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: Array<{ provider: string; id: string }>;
}) {
  return resolveModelSelectionFromDirective({
    directives: parseInlineDirectives(params.command),
    cfg: { commands: { text: true } } as unknown as OpenClawConfig,
    agentDir: "/tmp/agent",
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
    agentDir: "/tmp/agent",
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

  it("stores future-thread default on parent Telegram chat when /model is set in a topic", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const threadSessionKey = "agent:main:telegram:group:-100123:topic:77";
    const parentSessionKey = "agent:main:telegram:group:-100123";
    const sessionEntry = createSessionEntry();
    const parentEntry = createSessionEntry({ sessionId: "parent-1" });
    const sessionStore = {
      [threadSessionKey]: sessionEntry,
      [parentSessionKey]: parentEntry,
    };

    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionKey: threadSessionKey,
        sessionEntry,
        sessionStore,
      }),
    );

    expect(result?.text).toContain("Model set to openai/gpt-4o");
    expect(result?.text).toContain("New threads in this chat will default to openai/gpt-4o");
    expect(sessionStore[parentSessionKey]?.futureThreadProviderOverride).toBe("openai");
    expect(sessionStore[parentSessionKey]?.futureThreadModelOverride).toBe("gpt-4o");
  });

  it("stores future-thread default on main parent for Telegram DM main-scoped thread keys", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const threadSessionKey = "agent:main:main:thread:123456789:42";
    const parentSessionKey = "agent:main:main";
    const sessionEntry = createSessionEntry({ channel: "telegram" });
    const parentEntry = createSessionEntry({ sessionId: "parent-main-1" });
    const sessionStore = {
      [threadSessionKey]: sessionEntry,
      [parentSessionKey]: parentEntry,
    };

    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionKey: threadSessionKey,
        sessionEntry,
        sessionStore,
      }),
    );

    expect(result?.text).toContain("Model set to openai/gpt-4o");
    expect(result?.text).toContain("New threads in this chat will default to openai/gpt-4o");
    expect(sessionStore[parentSessionKey]?.futureThreadProviderOverride).toBe("openai");
    expect(sessionStore[parentSessionKey]?.futureThreadModelOverride).toBe("gpt-4o");
  });

  it("stores future-thread default on explicit non-Telegram parent session", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const threadSessionKey = "agent:main:discord:channel:thread-777";
    const parentSessionKey = "agent:main:discord:channel:parent-123";
    const sessionEntry = createSessionEntry({ channel: "discord" });
    const parentEntry = createSessionEntry({ sessionId: "parent-discord-1" });
    const sessionStore = {
      [threadSessionKey]: sessionEntry,
      [parentSessionKey]: parentEntry,
    };

    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionKey: threadSessionKey,
        parentSessionKey,
        sessionEntry,
        sessionStore,
      }),
    );

    expect(result?.text).toContain("Model set to openai/gpt-4o");
    expect(result?.text).toContain("New threads in this chat will default to openai/gpt-4o");
    expect(sessionStore[parentSessionKey]?.futureThreadProviderOverride).toBe("openai");
    expect(sessionStore[parentSessionKey]?.futureThreadModelOverride).toBe("gpt-4o");
  });

  it("clears parent future-thread default when /model resets to configured default in a Telegram topic", async () => {
    const directives = parseInlineDirectives("/model anthropic/claude-opus-4-5");
    const threadSessionKey = "agent:main:telegram:group:-100123:topic:77";
    const parentSessionKey = "agent:main:telegram:group:-100123";
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const parentEntry = createSessionEntry({
      sessionId: "parent-2",
      futureThreadProviderOverride: "openai",
      futureThreadModelOverride: "gpt-4o",
    });
    const sessionStore = {
      [threadSessionKey]: sessionEntry,
      [parentSessionKey]: parentEntry,
    };

    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionKey: threadSessionKey,
        sessionEntry,
        sessionStore,
      }),
    );

    expect(result?.text).toContain("Model reset to default");
    expect(result?.text).toContain("New threads in this chat now follow the default model.");
    expect(sessionStore[parentSessionKey]?.futureThreadProviderOverride).toBeUndefined();
    expect(sessionStore[parentSessionKey]?.futureThreadModelOverride).toBeUndefined();
  });
});
