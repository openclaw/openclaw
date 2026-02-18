import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { ModelTier, TaskType, type RoutingConfig } from "../../gateway/routing/types.js";
import type { TemplateContext } from "../templating.js";
import { buildTestCtx } from "./test-ctx.js";

const taskResolverMock = vi.hoisted(() => ({
  resolveTaskType: vi.fn(() => TaskType.CODE_EDIT),
}));

const applyDirectivesMock = vi.hoisted(() => ({
  applyInlineDirectiveOverrides: vi.fn(async (params) => ({
    kind: "continue",
    directives: params.directives,
    provider: params.provider,
    model: params.model,
    contextTokens: params.contextTokens,
    directiveAck: undefined,
    perMessageQueueMode: undefined,
    perMessageQueueOptions: undefined,
  })),
}));

const modelSelectionMock = vi.hoisted(() => ({
  createModelSelectionState: vi.fn(async (params) => ({
    provider: params.provider,
    model: params.model,
    allowedModelKeys: new Set(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    resolveDefaultThinkingLevel: async () => "off",
    needsModelCatalog: false,
  })),
  resolveContextTokens: vi.fn(() => 2048),
}));

const sandboxMock = vi.hoisted(() => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

const elevatedMock = vi.hoisted(() => ({
  resolveElevatedPermissions: vi.fn(() => ({ enabled: false, allowed: false, failures: [] })),
  formatElevatedUnavailableMessage: vi.fn(() => "blocked"),
}));

const sessionStoreMock = vi.hoisted(() => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../gateway/routing/task-resolver.js", () => taskResolverMock);
vi.mock("./get-reply-directives-apply.js", () => applyDirectivesMock);
vi.mock("./model-selection.js", () => modelSelectionMock);
vi.mock("../../agents/sandbox.js", () => sandboxMock);
vi.mock("./reply-elevated.js", () => elevatedMock);
vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: sessionStoreMock.updateSessionStore,
  };
});

const { resolveReplyDirectives } = await import("./get-reply-directives.js");

const baseRoutingConfig: RoutingConfig = {
  default_task_type: TaskType.FALLBACK,
  cooldown_seconds: 30,
  antiflap_enabled: false,
  triggers: {},
  deny_list: [],
  ha_matrix: {
    [TaskType.CODE_EDIT]: {
      [ModelTier.TIER1]: "openai/gpt-4o",
      [ModelTier.TIER2]: "anthropic/claude-3-sonnet",
    },
    [TaskType.FALLBACK]: {
      [ModelTier.TIER1]: "anthropic/claude-opus-4-5",
    },
  },
};

const aliasIndex: ModelAliasIndex = { byAlias: new Map(), byKey: new Map() };

function buildConfig(routing: RoutingConfig): OpenClawConfig {
  return {
    commands: { text: false },
    agents: { defaults: {} },
    routing,
  } as unknown as OpenClawConfig;
}

function buildSessionCtx(body: string): TemplateContext {
  const ctx = buildTestCtx({
    Body: body,
    CommandBody: body,
    BodyForCommands: body,
    CommandAuthorized: true,
  });
  return {
    ...ctx,
    BodyStripped: body,
    BodyForAgent: body,
  };
}

function buildParams(params: {
  cfg: OpenClawConfig;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
}) {
  const ctx = buildTestCtx({
    Body: "Please edit the code",
    CommandBody: "Please edit the code",
    BodyForCommands: "Please edit the code",
    CommandAuthorized: true,
  });
  const sessionCtx = buildSessionCtx("Please edit the code");

  return {
    ctx,
    cfg: params.cfg,
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    agentCfg: {},
    sessionCtx,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    sessionScope: "per-sender" as const,
    groupResolution: null,
    isGroup: false,
    triggerBodyNormalized: "",
    commandAuthorized: true,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-5",
    aliasIndex,
    provider: "anthropic",
    model: "claude-opus-4-5",
    hasResolvedHeartbeatModelOverride: false,
    typing: { cleanup: vi.fn() },
    opts: undefined,
    skillFilter: undefined,
  };
}

beforeEach(() => {
  taskResolverMock.resolveTaskType.mockClear();
  applyDirectivesMock.applyInlineDirectiveOverrides.mockClear();
  modelSelectionMock.createModelSelectionState.mockClear();
  sessionStoreMock.updateSessionStore.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveReplyDirectives antiflap routing", () => {
  it("keeps existing routing behavior when antiflap is disabled", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const routing = { ...baseRoutingConfig, antiflap_enabled: false };
    const cfg = buildConfig(routing);
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 0,
      lastRoutedModel: "anthropic/claude-opus-4-5",
      lastRoutedAt: 1_700_000_000_000,
    };
    const sessionKey = "agent:main:main";
    const sessionStore = { [sessionKey]: sessionEntry };

    const result = await resolveReplyDirectives(
      buildParams({ cfg, sessionEntry, sessionStore, sessionKey }),
    );

    expect(result.kind).toBe("continue");
    if (result.kind === "continue") {
      expect(result.result.provider).toBe("openai");
      expect(result.result.model).toBe("gpt-4o");
    }
    expect(taskResolverMock.resolveTaskType).toHaveBeenCalledTimes(1);
  });

  it("reuses last routed model during antiflap cooldown", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const routing = { ...baseRoutingConfig, antiflap_enabled: true };
    const cfg = buildConfig(routing);
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 0,
      lastRoutedModel: "anthropic/claude-opus-4-5",
      lastRoutedAt: 1_699_999_990_000,
    };
    const sessionKey = "agent:main:main";
    const sessionStore = { [sessionKey]: sessionEntry };

    const result = await resolveReplyDirectives(
      buildParams({ cfg, sessionEntry, sessionStore, sessionKey }),
    );

    expect(result.kind).toBe("continue");
    if (result.kind === "continue") {
      expect(result.result.provider).toBe("anthropic");
      expect(result.result.model).toBe("claude-opus-4-5");
    }
    expect(taskResolverMock.resolveTaskType).not.toHaveBeenCalled();
    expect(sessionEntry.lastRoutedAt).toBe(1_699_999_990_000);
  });

  it("re-resolves routing after cooldown expires", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const routing = { ...baseRoutingConfig, antiflap_enabled: true };
    const cfg = buildConfig(routing);
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 0,
      lastRoutedModel: "anthropic/claude-opus-4-5",
      lastRoutedAt: 1_699_999_960_000,
    };
    const sessionKey = "agent:main:main";
    const sessionStore = { [sessionKey]: sessionEntry };

    const result = await resolveReplyDirectives(
      buildParams({
        cfg,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath: "/tmp/sessions.json",
      }),
    );

    expect(result.kind).toBe("continue");
    if (result.kind === "continue") {
      expect(result.result.provider).toBe("openai");
      expect(result.result.model).toBe("gpt-4o");
    }
    expect(taskResolverMock.resolveTaskType).toHaveBeenCalledTimes(1);
    expect(sessionEntry.lastRoutedModel).toBe("openai/gpt-4o");
    expect(sessionEntry.lastRoutedAt).toBe(1_700_000_000_000);
    expect(sessionStoreMock.updateSessionStore).toHaveBeenCalledTimes(1);
  });
});
