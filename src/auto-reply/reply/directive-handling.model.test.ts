// Tests model directive handling, auth profiles, and persisted provider overrides.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveAuthStorePathForDisplay } from "../../agents/auth-profiles/paths.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { prepareModelCatalogAuthLabels } from "../../agents/model-catalog-auth-labels.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { bindPreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "../../plugins/provider-thinking.types.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import {
  createModelsTestOwner,
  setFastModelsCliBackendDeps,
} from "./commands-models.test-support.js";

const authProfilesStoreMock = vi.hoisted(() => ({
  profiles: {} as Record<
    string,
    | { type: "api_key"; provider: string; key: string }
    | { type: "oauth"; provider: string; access: string; refresh: string; expires: number }
    | { type: "token"; provider: string; token: string }
  >,
}));
const stickyModelMock = vi.hoisted(() => ({
  persistBestEffort: vi.fn(),
}));
const pluginPolicyMock = vi.hoisted(() => ({
  channels: new Map<string, Pick<ChannelPlugin, "id" | "commands">>(),
  thinkingProfiles: new Map<
    string,
    (context: ProviderDefaultThinkingPolicyContext) => ProviderThinkingProfile | null | undefined
  >(),
}));

function readAuthProfileStoreForTest() {
  return { version: 1, profiles: authProfilesStoreMock.profiles };
}

// Runtime eligibility belongs to the published-owner tests; these cases exercise its consumers.
vi.mock("../../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: vi.fn<
    typeof import("../../agents/model-runtime-choice.js").preparePublishedModelRuntimeChoice
  >(async ({ runtimeId, preferredRuntimeId }) => ({
    kind: "ready",
    runtimeId: runtimeId ?? preferredRuntimeId ?? "openclaw",
    validate: () => undefined,
  })),
}));

vi.mock("../../agents/sticky-model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sticky-model-selection.js")>()),
  persistStickyModelSelectionBestEffort: (params: {
    agentId: string;
    model: string;
    target: "agent" | "defaults";
  }) => stickyModelMock.persistBestEffort(params),
}));

vi.mock("../../agents/auth-profiles/store.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../../agents/auth-profiles/store.js")>()),
    getRuntimeAuthProfileStoreSnapshot: readAuthProfileStoreForTest,
  };
});
vi.mock("../../agents/auth-profiles/source-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/source-check.js")>()),
  hasAnyAuthProfileStoreSourceAsync: async () =>
    Object.keys(authProfilesStoreMock.profiles).length > 0,
}));
// mock-isolation: Directive tests own the in-memory credential map and stub writes; real persistence stays isolated.
vi.mock("../../agents/auth-profiles/store-runtime.js", () => {
  return {
    ensureAuthProfileStore: readAuthProfileStoreForTest,
    ensureAuthProfileStoreAsync: async () => readAuthProfileStoreForTest(),
    prepareAuthProfileProvider: async ({ profileId }: { profileId: string }) => ({
      provider: authProfilesStoreMock.profiles[profileId]?.provider,
    }),
    findPersistedAuthProfileCredentialAsync: async ({ profileId }: { profileId: string }) =>
      authProfilesStoreMock.profiles[profileId],
    ensureAuthProfileStoreWithoutExternalProfiles: readAuthProfileStoreForTest,
    ensureAuthProfileStoreWithoutExternalProfilesAsync: async () => readAuthProfileStoreForTest(),
    ensureAuthProfileStoreForLocalUpdate: readAuthProfileStoreForTest,
    loadAuthProfileStore: readAuthProfileStoreForTest,
    loadAuthProfileStoreForRuntime: readAuthProfileStoreForTest,
    loadAuthProfileStoreForSecretsRuntime: readAuthProfileStoreForTest,
    loadAuthProfileStoreWithoutExternalProfiles: readAuthProfileStoreForTest,
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async ({ update }) =>
      update(readAuthProfileStoreForTest()),
    ),
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (id: string) => pluginPolicyMock.channels.get(id),
}));

vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: ({
    provider,
    context,
  }: {
    provider: string;
    context: ProviderDefaultThinkingPolicyContext;
  }) => pluginPolicyMock.thinkingProfiles.get(provider)?.(context),
}));

import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type InternalHookEvent,
} from "../../hooks/internal-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import type { ElevatedLevel } from "../thinking.js";
import { registerModelRuntimeDirectiveTests } from "./directive-handling.model-runtime.test-support.js";
import { registerModelStatusDirectiveTests } from "./directive-handling.model-status.test-support.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";

let handleDirectiveOnly: typeof import("./directive-handling.impl.js").handleDirectiveOnly;
let maybeHandleModelDirectiveInfo: typeof import("./directive-handling.model.js").maybeHandleModelDirectiveInfo;
let createModelVisibilityPolicy: typeof import("../../agents/model-visibility-policy.js").createModelVisibilityPolicy;
let buildModelAliasIndex: typeof import("../../agents/model-selection.js").buildModelAliasIndex;
let resolveModelSelectionFromDirective: typeof import("./directive-handling.model-selection.js").resolveModelSelectionFromDirective;
let parseInlineSessionDirectives: typeof import("./directive-handling.parse.js").parseInlineSessionDirectives;
let applyInlineDirectiveOverrides: typeof import("./get-reply-directives-apply.js").applyInlineDirectiveOverrides;

beforeAll(async () => {
  ({ handleDirectiveOnly } = await import("./directive-handling.impl.js"));
  ({ maybeHandleModelDirectiveInfo } = await import("./directive-handling.model.js"));
  ({ createModelVisibilityPolicy } = await import("../../agents/model-visibility-policy.js"));
  ({ buildModelAliasIndex } = await import("../../agents/model-selection.js"));
  ({ resolveModelSelectionFromDirective } =
    await import("./directive-handling.model-selection.js"));
  ({ parseInlineSessionDirectives } = await import("./directive-handling.parse.js"));
  ({ applyInlineDirectiveOverrides } = await import("./get-reply-directives-apply.js"));
});
const queueMocks = vi.hoisted(() => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

// Mock dependencies for directive handling persistence.
vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: () => [],
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveNativeModelPrimary: vi.fn(() => undefined),
  resolveAgentModelFallbacksOverride: vi.fn(() => undefined),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveSessionAgentIds: () => ({ sessionAgentId: "main" }),
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/prepared-model-catalog.js", () => {
  const entries = [
    { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
    { provider: "localai", id: "ultra-chat", name: "Ultra Chat" },
  ];
  const loadOwner = (params: {
    config: OpenClawConfig;
    agentId?: string;
    agentDir?: string;
    workspaceDir?: string;
  }) => {
    const owner = createModelsTestOwner(params.config, entries, params);
    const store = readAuthProfileStoreForTest();
    bindPreparedModelRuntimeAuth(owner, {
      store,
      labels: prepareModelCatalogAuthLabels({
        config: params.config,
        agentDir: owner.agentDir,
        authStorePath: resolveAuthStorePathForDisplay(owner.agentDir),
        workspaceDir: owner.workspaceDir,
        env: {},
        store,
        providers: [
          "openai",
          "anthropic",
          "openrouter",
          "localai",
          ...Object.keys(params.config.models?.providers ?? {}),
        ],
      }),
    });
    return owner;
  };
  return {
    readPreparedModelCatalog: async () => entries,
    loadProviderScopedThinkingCatalog: async () => entries,
    getPublishedPreparedModelCatalogOwnerSnapshot: loadOwner,
    loadPreparedModelCatalogOwnerSnapshot: () => {
      throw new Error("Status must use the published catalog owner");
    },
    loadPublishedPreparedModelCatalogOwnerSnapshot: async (
      params: Parameters<typeof loadOwner>[0],
    ) => loadOwner(params),
    materializePreparedModelCatalogOwner: (owner: object) => owner,
  };
});

// mock-isolation: Exercise model directives without sandbox backend or session storage setup.
vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatusAsync: vi.fn(async () => ({ sandboxed: false })),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) =>
    queueMocks.refreshQueuedFollowupSession(...args),
}));

const TEST_AGENT_DIR = "/tmp/agent";
const OPENAI_DATE_PROFILE_ID = "20251001";

type AuthProfileForTest = (typeof authProfilesStoreMock.profiles)[string];
type ApiKeyProfile = Extract<AuthProfileForTest, { type: "api_key" }>;

function baseAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

function baseConfig(): OpenClawConfig {
  return {
    commands: { text: true },
    agents: { defaults: {} },
  } as unknown as OpenClawConfig;
}

function createSessionEntry(overrides?: Partial<InternalSessionEntry>): InternalSessionEntry {
  return {
    sessionId: "s1",
    updatedAt: Date.now(),
    delivery: { kind: "none" },
    ...overrides,
  };
}

function setDirectiveTestProviders(
  providers: Array<{
    id: string;
    label?: string;
    auth?: unknown[];
    resolveThinkingProfile?: (
      context: ProviderDefaultThinkingPolicyContext,
    ) => ProviderThinkingProfile | null | undefined;
  }>,
): void {
  pluginPolicyMock.thinkingProfiles.clear();
  for (const provider of providers) {
    if (provider.resolveThinkingProfile) {
      pluginPolicyMock.thinkingProfiles.set(provider.id, provider.resolveThinkingProfile);
    }
  }
}

function setOpenAiRuntimeScopedUltraProvider(): void {
  setDirectiveTestProviders([
    {
      id: "openai",
      label: "OpenAI",
      auth: [],
      resolveThinkingProfile: ({ agentRuntime }) => ({
        levels: [
          { id: "off" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "max" },
          ...(agentRuntime === "openclaw" ? ([{ id: "ultra" }] as const) : []),
        ],
      }),
    },
  ]);
}

beforeEach(() => {
  vi.useRealTimers();
  setFastModelsCliBackendDeps();
  setDirectiveTestProviders([]);
  pluginPolicyMock.channels.clear();
  authProfilesStoreMock.profiles = {};
  vi.mocked(resolveAgentDir).mockReset().mockReturnValue(TEST_AGENT_DIR);
  vi.mocked(resolveSessionAgentId).mockReset().mockReturnValue("main");
  vi.mocked(enqueueSystemEvent).mockClear();
  queueMocks.refreshQueuedFollowupSession.mockReset();
  stickyModelMock.persistBestEffort.mockReset().mockReturnValue("requested");
  clearInternalHooks();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  cliBackendsTesting.resetDepsForTest();
  setDirectiveTestProviders([]);
  pluginPolicyMock.channels.clear();
  clearInternalHooks();
});

function setAuthProfiles(profiles: Record<string, AuthProfileForTest>) {
  authProfilesStoreMock.profiles = profiles;
}

function createDateAuthProfiles(provider: string, id = OPENAI_DATE_PROFILE_ID) {
  return {
    [id]: {
      type: "api_key",
      provider,
      key: "sk-test",
    },
  } satisfies Record<string, ApiKeyProfile>;
}

function createGptAliasIndex(): ModelAliasIndex {
  return {
    byAlias: new Map([["gpt", { alias: "gpt", ref: { provider: "openai", model: "gpt-4o" } }]]),
    byKey: new Map([["openai/gpt-4o", ["gpt"]]]),
  };
}

function resolveModelSelectionForCommand(params: {
  command: string;
  allowedModelKeys: Set<string>;
  cfg?: OpenClawConfig;
  agentId?: string;
}) {
  return resolveModelSelectionFromDirective({
    directives: parseInlineSessionDirectives(params.command),
    cfg: params.cfg ?? {
      commands: { text: true },
      agents: { defaults: { modelPolicy: { allow: [...params.allowedModelKeys] } } },
    },
    agentId: params.agentId,
    agentDir: TEST_AGENT_DIR,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: baseAliasIndex(),
    allowedModelKeys: params.allowedModelKeys,
  });
}

async function persistModelDirectiveForTest(params: {
  command: string;
  directiveOnly?: boolean;
  agentId?: string;
  profiles?: Record<string, ApiKeyProfile>;
  cfg?: OpenClawConfig;
  aliasIndex?: ModelAliasIndex;
  allowedModelKeys: string[];
  allowedModelCatalog?: ModelCatalogEntry[];
  sessionEntry?: SessionEntry;
  provider?: string;
  model?: string;
  initialModelLabel?: string;
  canPersistStickyModelSelection?: boolean;
  isAuthorizedSender?: boolean;
}) {
  if (params.profiles) {
    setAuthProfiles(params.profiles);
  }
  const originalDirectives = parseInlineSessionDirectives(params.command);
  const commandBody =
    params.directiveOnly || originalDirectives.cleaned.trim()
      ? params.command
      : `${params.command} continue with the request`;
  const directives = parseInlineSessionDirectives(commandBody);
  const cfg = params.cfg ?? baseConfig();
  const sessionEntry = params.sessionEntry ?? createSessionEntry();
  const provider = params.provider ?? "anthropic";
  const model = params.model ?? "claude-opus-4-6";
  const agentId = params.agentId ?? "main";
  const sessionKey = `agent:${agentId}:dm:1`;
  const modelState = createModelSelectionStateFixture({
    agentCfg: cfg.agents?.defaults,
    provider,
    model,
  });
  modelState.allowedModelKeys = new Set(params.allowedModelKeys);
  modelState.allowedModelCatalog = params.allowedModelCatalog ?? [];
  modelState.resolveThinkingCatalog = async () => params.allowedModelCatalog;
  const result = await applyInlineDirectiveOverrides({
    ctx: { Body: commandBody, Provider: "telegram", Surface: "telegram" },
    cfg,
    agentId,
    agentDir: TEST_AGENT_DIR,
    workspaceDir: "/tmp/workspace",
    agentCfg: cfg.agents?.defaults ?? {},
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    sessionScope: undefined,
    isGroup: false,
    allowTextCommands: true,
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: [],
      senderIsOwner: params.canPersistStickyModelSelection ?? true,
      isAuthorizedSender: params.isAuthorizedSender ?? true,
      rawBodyNormalized: commandBody,
      commandBodyNormalized: commandBody,
    },
    directives,
    elevatedEnabled: false,
    elevatedAllowed: false,
    elevatedFailures: [],
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: params.aliasIndex ?? baseAliasIndex(),
    provider,
    model,
    modelState,
    initialModelLabel: params.initialModelLabel ?? `${provider}/${model}`,
    formatModelSwitchEvent: (label) => label,
    resolvedElevatedLevel: "off",
    defaultActivation: () => "always",
    contextTokens: 8192,
    effectiveModelDirective: directives.rawModelDirective,
    typing: {
      onReplyStart: async () => {},
      startTypingLoop: async () => {},
      startTypingOnText: async () => {},
      refreshTypingTtl: () => {},
      isActive: () => false,
      markRunComplete: () => {},
      markDispatchIdle: () => {},
      cleanup: () => {},
    },
  });
  const persisted =
    result.kind === "continue"
      ? {
          provider: result.provider,
          model: result.model,
          contextTokens: result.contextTokens,
          directiveAck: result.directiveAck,
          errorText: undefined,
        }
      : {
          provider,
          model,
          contextTokens: 8192,
          directiveAck: undefined,
          errorText: Array.isArray(result.reply) ? result.reply[0]?.text : result.reply?.text,
        };
  return { persisted, sessionEntry, result };
}

type HandleDirectiveParams = Parameters<typeof handleDirectiveOnly>[0];
const EXEC_DEFAULTS_DIRECTIVE = "/exec host=node security=allowlist ask=always node=worker-1";
const VERBOSE_DEFAULT_DIRECTIVE = "/verbose full";

function createDirectiveHandlingParams(
  overrides: Partial<HandleDirectiveParams>,
): HandleDirectiveParams {
  const sessionKey = overrides.sessionKey ?? "agent:main:main";
  const sessionEntry = overrides.sessionEntry ?? createSessionEntry();
  return {
    cfg: baseConfig(),
    agentId: "main",
    directives: parseInlineSessionDirectives(""),
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    elevatedEnabled: true,
    elevatedAllowed: true,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: baseAliasIndex(),
    allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]),
    allowedModelCatalog: [],
    resetModelOverride: false,
    provider: "anthropic",
    model: "claude-opus-4-6",
    initialModelLabel: "anthropic/claude-opus-4-6",
    formatModelSwitchEvent: (label) => `Switched to ${label}`,
    ...overrides,
  };
}

async function persistInternalOperatorWriteDirective(
  command: string,
  overrides: Partial<HandleDirectiveParams> = {},
) {
  const sessionEntry = overrides.sessionEntry ?? createSessionEntry();
  await handleDirectiveOnly(
    createDirectiveHandlingParams({
      directives: parseInlineSessionDirectives(command),
      sessionEntry,
      surface: "webchat",
      gatewayClientScopes: ["operator.write"],
      ...overrides,
    }),
  );
  return sessionEntry;
}

function externalChannelPolicy(overrides: Partial<HandleDirectiveParams> = {}) {
  return { messageProvider: "telegram", surface: "telegram", ...overrides };
}

function expectExecDefaults(sessionEntry: SessionEntry, persisted: boolean) {
  expect(sessionEntry.execHost).toBe(persisted ? "node" : undefined);
  expect(sessionEntry.execNode).toBe(persisted ? "worker-1" : undefined);
}

async function resolveModelInfoReply(
  overrides: Partial<Parameters<typeof maybeHandleModelDirectiveInfo>[0]> = {},
) {
  return maybeHandleModelDirectiveInfo({
    directives: parseInlineSessionDirectives("/model"),
    cfg: baseConfig(),
    agentDir: TEST_AGENT_DIR,
    activeAgentId: "main",
    provider: "anthropic",
    model: "claude-opus-4-6",
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: baseAliasIndex(),
    allowedModelCatalog: [],
    currentThinkLevel: "medium",
    runtimePolicySessionKey: "agent:main:main",
    resetModelOverride: false,
    ...overrides,
  });
}

describe("/model chat UX", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([
    ["/model list@work", "Auth profile override requires a model selection."],
    ["/model status --runtime codex", "Runtime override requires a model selection."],
    ["/model list -s", "Session-only scope requires a model selection."],
    ["/model status --agent", "Agent scope requires a model selection."],
    ["/model list --global", "Global scope requires a model selection."],
  ])("rejects action options on informational model commands: %s", async (command, text) => {
    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives(command),
    });

    expect(reply).toEqual({ text, isError: true });
  });

  it("includes the thinking level in channel-specific model summaries", async () => {
    pluginPolicyMock.channels.set("telegram", {
      id: "telegram",
      commands: {
        buildModelBrowseChannelData: () => ({ telegram: { inlineKeyboard: [] } }),
      },
    });

    const reply = await resolveModelInfoReply({ surface: "telegram" });

    expect(reply?.channelData).toBeDefined();
    expect(reply?.text).toContain("Think: medium (change with /think <level>)");
    expect(reply?.text).toContain("Tap below to select a model");
    expect(reply?.text).toContain("/model <provider/model> -s for this session only");
    expect(reply?.text).toContain("/model <provider/model> -a to update this agent's default");
    expect(reply?.text).toContain("/model <provider/model> -g to update the global default");
    expect(reply?.text).toContain(
      "/model <provider/model> --runtime <runtime> -s to switch harnesses",
    );
  });

  it.each(["/model"])(
    "%s reads terminal fallback from the transcript scope, not the runtime-policy key",
    async (command) => {
      const tempRoot = tempDirs.make("openclaw-model-terminal-display-");
      const stateDir = path.join(tempRoot, "state");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const cfg = baseConfig();
        setRuntimeConfigSnapshot(cfg);
        const sessionKey = "agent:main:main";
        const storePath = path.join(tempRoot, "custom-store", "openclaw-agent.sqlite");
        const scope = { agentId: "main", sessionKey, sessionId: "terminal-display", storePath };
        try {
          await replaceSessionEntry(
            scope,
            createSessionEntry({
              sessionId: scope.sessionId,
              status: "done",
              lastRunId: "settled-run",
              fallbackNotice: {
                kind: "active",
                selectedModel: "anthropic/claude-opus-4-6",
                activeModel: "anthropic/claude-haiku-4-5",
                reason: "rate limit",
              },
            }),
          );
          await persistSessionTranscriptTurn(scope, {
            runId: "settled-run",
            messages: [
              {
                eventId: "terminal-answer",
                parentId: null,
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "The fallback answered." }],
                  provider: "anthropic",
                  model: "claude-haiku-4-5",
                  stopReason: "stop",
                },
              },
            ],
            touchSessionEntry: false,
            updateMode: "none",
          });
          const sessionEntry = expectDefined(loadSessionEntry(scope), "persisted model session");
          const before = structuredClone(sessionEntry);
          const reply = await handleDirectiveOnly(
            createDirectiveHandlingParams({
              cfg,
              directives: parseInlineSessionDirectives(command),
              sessionEntry,
              sessionKey,
              storePath,
              ctx: { RuntimePolicySessionKey: "agent:main:telegram:default:direct:fixture-user" },
            }),
          );
          expect(reply?.text).toContain("Current: anthropic/claude-opus-4-6");
          expect(reply?.text).toContain("Active: anthropic/claude-haiku-4-5 (runtime)");
          expect(sessionEntry).toEqual(before);
          expect(loadSessionEntry(scope)).toEqual(before);
        } finally {
          await cleanupSessionStateForTest({ stateDir, rootPath: tempRoot });
        }
      });
    },
  );

  registerModelStatusDirectiveTests({
    resolveModelInfoReply,
    parseInlineSessionDirectives: (...args) => parseInlineSessionDirectives(...args),
    createModelVisibilityPolicy: (...args) => createModelVisibilityPolicy(...args),
    buildModelAliasIndex: (...args) => buildModelAliasIndex(...args),
  });

  it("includes additive allowlist repair when a runtime switch targets a blocked model", async () => {
    const resolved = await resolveModelSelectionForCommand({
      command: "/model openai/gpt-5.5 --runtime codex",
      allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]),
    });

    expect(resolved.modelSelection).toBeUndefined();
    expect(resolved.errorText).toContain('Model "openai/gpt-5.5" is not allowed.');
    expect(resolved.errorText).toContain(
      'Add "openai/gpt-5.5" or its provider wildcard to agents.defaults.modelPolicy.allow.',
    );
    expect(resolved.errorText).toContain("Then retry: /model openai/gpt-5.5 --runtime codex");
    expect(resolved.errorText).toContain("openclaw plugins enable codex");
  });

  it("keeps @YYYYMMDD as part of the model when the stored numeric profile is for another provider", async () => {
    setAuthProfiles(createDateAuthProfiles("anthropic"));

    const resolved = await resolveModelSelectionForCommand({
      command: `/model custom/vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`,
      allowedModelKeys: new Set([`custom/vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`]),
    });

    expect(resolved.errorText).toBeUndefined();
    expect(resolved.modelSelection).toEqual({
      provider: "custom",
      model: `vertex-ai_claude-haiku-4-5@${OPENAI_DATE_PROFILE_ID}`,
      isDefault: false,
    });
    expect(resolved.profileOverride).toBeUndefined();
  }, 240_000);

  it("clears runtime overrides when the model directive asks for default runtime", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o --runtime default hello",
      allowedModelKeys: ["openai/gpt-4o"],
      sessionEntry: createSessionEntry({ agentRuntimeOverride: "codex" }),
      provider: "openai",
      model: "gpt-4o",
      initialModelLabel: "openai/gpt-4o",
    });

    expect(sessionEntry.agentRuntimeOverride).toBeUndefined();
  });

  registerModelRuntimeDirectiveTests({
    setOpenAiRuntimeScopedUltraProvider,
    createSessionEntry,
    createGptAliasIndex,
    persistModelDirectiveForTest,
    queueMocks,
    stickyModelMock,
  });

  it("persists providerless numeric auth-profile overrides for mixed-content messages", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: `/model gpt-4o@${OPENAI_DATE_PROFILE_ID} hello`,
      profiles: createDateAuthProfiles("openai"),
      allowedModelKeys: ["openai/gpt-4o"],
    });

    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe(OPENAI_DATE_PROFILE_ID);
  });

  it("ignores invalid mixed-content model directives during persistence", async () => {
    const { persisted, sessionEntry } = await persistModelDirectiveForTest({
      command: "/model 99 hello",
      profiles: createDateAuthProfiles("openai"),
      allowedModelKeys: ["openai/gpt-4o"],
      sessionEntry: createSessionEntry({
        providerOverride: "openai",
        modelOverride: "gpt-4o",
        authProfileOverride: OPENAI_DATE_PROFILE_ID,
        authProfileOverrideSource: "user",
      }),
      provider: "openai",
      model: "gpt-4o",
      initialModelLabel: "openai/gpt-4o",
    });

    expect(persisted.provider).toBe("openai");
    expect(persisted.model).toBe("gpt-4o");
    expect(sessionEntry.providerOverride).toBe("openai");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(sessionEntry.authProfileOverride).toBe(OPENAI_DATE_PROFILE_ID);
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
  });
});

describe("handleDirectiveOnly model persist behavior (fixes #1435)", () => {
  const allowedModelKeys = new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]);
  const allowedModelCatalog = [
    { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  ];
  const sessionKey = "agent:main:dm:1";

  type HandleParams = Parameters<typeof handleDirectiveOnly>[0];

  function createHandleParams(overrides: Partial<HandleParams>): HandleParams {
    return createDirectiveHandlingParams({
      sessionKey: `agent:${overrides.agentId ?? "main"}:dm:1`,
      elevatedEnabled: false,
      elevatedAllowed: false,
      allowedModelKeys,
      allowedModelCatalog,
      ...overrides,
    });
  }

  function runHandleCommand(command: string, overrides: Partial<HandleParams> = {}) {
    return handleDirectiveOnly(
      createHandleParams({ ...overrides, directives: parseInlineSessionDirectives(command) }),
    );
  }

  it("preserves a compatible auth profile for a mixed model directive", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5",
      authProfileOverride: "team:prod",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });

    await runHandleCommand("/model openai/gpt-4o", {
      cfg: {
        ...baseConfig(),
        auth: { profiles: { "team:prod": { provider: "openai", mode: "api_key" } } },
      },
      provider: "openai",
      model: "gpt-5",
      sessionEntry,
    });

    expect(sessionEntry.authProfileOverride).toBe("team:prod");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(sessionEntry.authProfileOverrideCompactionCount).toBe(2);
  });

  it("preserves an explicit runtime pin when a model switch omits --runtime", async () => {
    const sessionEntry = createSessionEntry({
      agentRuntimeOverride: "codex",
      nativeRuntimeConsent: "codex",
    });
    await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineSessionDirectives("/model openai/gpt-4o"),
        sessionEntry,
      }),
    );

    expect(sessionEntry.agentRuntimeOverride).toBe("codex");
    expect(sessionEntry.nativeRuntimeConsent).toBe("codex");
  });

  it("rejects model and runtime changes for model-locked sessions", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      modelSelectionLocked: true,
    });
    const initialSessionEntry = { ...sessionEntry };

    const result = await runHandleCommand("/model openai/gpt-4o --runtime openclaw", {
      sessionEntry,
    });

    expect(result?.text).toBe(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(result?.isError).toBe(true);
    expect(sessionEntry).toEqual(initialSessionEntry);
  });

  it("rechecks a newly persisted model lock before committing directive changes", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-directive-lock-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    });
    const lockedEntry: SessionEntry = {
      ...sessionEntry,
      updatedAt: sessionEntry.updatedAt + 1,
      modelSelectionLocked: true,
    };
    await replaceSessionEntry({ sessionKey, storePath }, lockedEntry);
    const sessionStore = { [sessionKey]: sessionEntry };

    try {
      const result = await runHandleCommand("/model openai/gpt-4o", {
        sessionEntry,
        sessionStore,
        storePath,
      });

      expect(result?.text).toBe(MODEL_SELECTION_LOCKED_MESSAGE);
      expect(result?.isError).toBe(true);
      expect(sessionEntry).toEqual(lockedEntry);
      expect(sessionStore[sessionKey]).toEqual(lockedEntry);
      expect(loadSessionEntry({ sessionKey, storePath })).toEqual(lockedEntry);
      expect(queueMocks.refreshQueuedFollowupSession).not.toHaveBeenCalled();
      expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      flag: "-g",
      target: "defaults",
      agentId: "main",
      selection: "openai/gpt-4o",
      model: "openai/gpt-4o",
    },
  ])(
    "persists $selection at explicit $target scope for $agentId",
    async ({ flag, target, agentId, selection, model }) => {
      await persistModelDirectiveForTest({
        command: `/model ${selection} ${flag} continue with the request`,
        agentId,
        allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
        allowedModelCatalog: [
          { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
        ],
      });
      expect(stickyModelMock.persistBestEffort).toHaveBeenCalledWith({ agentId, model, target });
    },
  );

  it.each([
    {
      command: "/model openai/gpt-4o -a continue with the request",
      canPersistStickyModelSelection: false,
      error: "require owner authority",
    },
    {
      command: "/model openai/gpt-4o -a -g continue with the request",
      canPersistStickyModelSelection: true,
      error: "only one model scope",
    },
  ])(
    "rejects persistent model scope: $error",
    async ({ command, canPersistStickyModelSelection, error }) => {
      const { persisted, sessionEntry } = await persistModelDirectiveForTest({
        command,
        allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
        canPersistStickyModelSelection,
      });

      expect(persisted.errorText).toContain(error);
      expect(sessionEntry.providerOverride).toBeUndefined();
      expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
    },
  );

  it("leaves a scoped model directive as plain text for an unauthorized sender", async () => {
    const { persisted, sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o -a continue with the request",
      allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
      // An unauthorized sender is never the owner; setting only one of these
      // describes a state the gateway cannot produce.
      isAuthorizedSender: false,
      canPersistStickyModelSelection: false,
    });

    // An unauthorized sender's directives are cleared to plain text, so the
    // persistent-scope authority error must not surface the command at all.
    expect(persisted.errorText).toBeUndefined();
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
  });

  it("suppresses model side effects when a concurrent switch wins", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-directive-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    });
    const concurrentEntry: SessionEntry = {
      ...sessionEntry,
      updatedAt: sessionEntry.updatedAt + 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
    };
    await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);
    const sessionStore = { [sessionKey]: sessionEntry };
    const persistenceState: NonNullable<HandleDirectiveParams["persistenceState"]> = {
      outcome: { kind: "pending", provider: "anthropic", model: "claude-opus-4-6" },
    };
    const patchEvents: InternalHookEvent[] = [];
    registerInternalHook("session:patch", async (event) => {
      patchEvents.push(event);
    });

    try {
      const result = await handleDirectiveOnly(
        createHandleParams({
          directives: parseInlineSessionDirectives("/model openai/gpt-4o"),
          sessionEntry,
          sessionStore,
          storePath,
          persistenceState,
        }),
      );

      expect(result?.text).toContain("Model change was not applied");
      expect(result?.isError).toBe(true);
      expect(persistenceState.outcome).toMatchObject({ kind: "rejected" });
      expect(queueMocks.refreshQueuedFollowupSession).not.toHaveBeenCalled();
      expect(patchEvents).toEqual([]);
      expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
        expect.stringContaining("openai/gpt-4o"),
        expect.anything(),
      );
      expect(sessionStore[sessionKey]).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      });
      expect(sessionStore[sessionKey]?.liveModelSwitchPending).toBeUndefined();
      expect(sessionEntry).toEqual(sessionStore[sessionKey]);
      expect(loadSessionEntry({ sessionKey, storePath })).toEqual(sessionStore[sessionKey]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports a rejected non-model directive after session rotation", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-elevated-directive-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createSessionEntry({ elevatedLevel: "full" });
    const rotatedEntry: SessionEntry = {
      sessionId: "s2",
      updatedAt: sessionEntry.updatedAt + 1,
      delivery: { kind: "none" },
      elevatedLevel: "full",
    };
    await replaceSessionEntry({ sessionKey, storePath }, rotatedEntry);
    const sessionStore = { [sessionKey]: sessionEntry };

    try {
      const result = await runHandleCommand("/elevated off", {
        sessionEntry,
        sessionStore,
        storePath,
        elevatedEnabled: true,
        elevatedAllowed: true,
        currentElevatedLevel: "full",
      });

      expect(result?.text).toContain("Session settings were not applied");
      expect(result?.isError).toBe(true);
      expect(result?.text).not.toContain("Elevated mode disabled");
      expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
        expect.stringContaining("Elevated"),
        expect.anything(),
      );
      expect(sessionStore[sessionKey]).toEqual(rotatedEntry);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects an explicit same-value directive after a concurrent change", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-elevated-directive-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createSessionEntry({ elevatedLevel: "off" });
    const concurrentEntry: SessionEntry = {
      ...sessionEntry,
      updatedAt: sessionEntry.updatedAt + 1,
      elevatedLevel: "full",
    };
    await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);

    try {
      const result = await runHandleCommand("/elevated off", {
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        storePath,
        elevatedEnabled: true,
        elevatedAllowed: true,
        currentElevatedLevel: "off",
      });

      expect(result?.text).toContain("Session settings were not applied");
      expect(result?.isError).toBe(true);
      expect(sessionEntry).toMatchObject({ sessionId: "s1", elevatedLevel: "full" });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves a concurrent thinking preference while applying an unrelated directive", async () => {
    setDirectiveTestProviders([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        resolveThinkingProfile: () => ({
          levels: [{ id: "off" }, { id: "low" }, { id: "high" }],
        }),
      },
    ]);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thinking-remap-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createSessionEntry({ thinkingLevel: "xhigh" });
    const concurrentEntry: SessionEntry = {
      ...sessionEntry,
      updatedAt: sessionEntry.updatedAt + 1,
      thinkingLevel: "low",
    };
    await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);

    try {
      const result = await runHandleCommand("/fast on", {
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        storePath,
      });

      expect(result?.isError).not.toBe(true);
      expect(sessionEntry).toMatchObject({ thinkingLevel: "low", fastMode: true });
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        thinkingLevel: "low",
        fastMode: true,
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { command: "/think off", initial: "low", expected: "off" },
    { command: "/think default", initial: "high", expected: undefined },
  ] as const)(
    "persists $command without confusing off with default",
    async ({ command, initial, expected }) => {
      const sessionEntry = createSessionEntry({ thinkingLevel: initial });
      const sessionStore = { [sessionKey]: sessionEntry };
      const result = await runHandleCommand(command, { sessionEntry, sessionStore });

      expect(result?.text ?? "").not.toContain("failed");
      if (expected === undefined) {
        expect(result?.text).toContain("Thinking level reset to default.");
      }
      expect(sessionEntry.thinkingLevel).toBe(expected);
      expect(sessionStore[sessionKey]?.thinkingLevel).toBe(expected);
    },
  );

  it("reports the effective thinking level for the pinned runtime", async () => {
    setOpenAiRuntimeScopedUltraProvider();
    const sessionEntry = createSessionEntry({
      thinkingLevel: "ultra",
      agentRuntimeOverride: "codex",
    });

    const result = await handleDirectiveOnly(
      createHandleParams({
        directives: parseInlineSessionDirectives("/think"),
        provider: "openai",
        model: "gpt-5.6-luna",
        currentThinkLevel: "ultra",
        sessionEntry,
      }),
    );

    expect(result?.text).toContain("Current thinking level: ultra.");
    expect(result?.text).toContain("Options: default, off, low, medium, high, max, ultra.");
  });

  it("rejects thinking levels forbidden by the concrete runtime policy", async () => {
    setDirectiveTestProviders([
      {
        id: "anthropic",
        resolveThinkingProfile: () => ({
          levels: [{ id: "minimal" }, { id: "medium" }, { id: "adaptive" }],
          defaultLevel: "adaptive",
          preserveWhenCatalogReasoningFalse: true,
        }),
      },
      {
        id: "claude-cli",
        resolveThinkingProfile: () => ({
          levels: [{ id: "off" }],
          defaultLevel: "off",
        }),
      },
    ]);
    const sessionEntry = createSessionEntry();
    const catalogEntry = {
      provider: "anthropic",
      id: "claude-mythos-5",
      name: "Claude Mythos 5",
      reasoning: false,
      thinkingPolicyProvider: "claude-cli",
    };

    const result = await runHandleCommand("/think medium", {
      provider: "anthropic",
      model: "claude-mythos-5",
      allowedModelKeys: new Set(["anthropic/claude-mythos-5"]),
      allowedModelCatalog: [catalogEntry],
      thinkingCatalog: [catalogEntry],
      sessionEntry,
    });

    expect(result?.text).toContain('Thinking level "medium" is not supported');
    expect(sessionEntry.thinkingLevel).toBeUndefined();
  });

  it("persists verbose on and off directives", async () => {
    const sessionEntry = createSessionEntry();

    const enabled = await runHandleCommand("/verbose on", { sessionEntry });
    expect(enabled?.text).toMatch(/^⚙️ Verbose logging enabled\./);
    expect(sessionEntry.verboseLevel).toBe("on");

    const disabled = await runHandleCommand("/verbose off", { sessionEntry });
    expect(disabled?.text).toMatch(/Verbose logging disabled\./);
    expect(sessionEntry.verboseLevel).toBe("off");
  });

  it("persists and reports fast-mode directives", async () => {
    const sessionEntry = createSessionEntry();

    const onReply = await runHandleCommand("/fast on", { sessionEntry });
    expect(onReply?.text).toContain("Fast mode enabled");
    expect(sessionEntry.fastMode).toBe(true);

    const statusReply = await runHandleCommand("/fast", {
      sessionEntry,
      currentFastMode: sessionEntry.fastMode,
    });
    expect(statusReply?.text).toContain("Current fast mode: on");

    const ultrafastReply = await runHandleCommand("/fast ultrafast", { sessionEntry });
    expect(ultrafastReply?.text).toContain("Ultrafast mode enabled.");
    expect(sessionEntry.fastMode).toBe("ultrafast");
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Ultrafast mode enabled.",
      expect.objectContaining({ contextKey: "fast:ultrafast" }),
    );

    const offReply = await runHandleCommand("/fast off", {
      sessionEntry,
      currentFastMode: sessionEntry.fastMode,
    });
    expect(offReply?.text).toContain("Fast mode disabled");
    expect(sessionEntry.fastMode).toBe(false);

    const defaultReply = await runHandleCommand("/fast default", {
      sessionEntry,
      currentFastMode: sessionEntry.fastMode,
    });
    expect(defaultReply?.text).toContain("Fast mode reset to default");
    expect(sessionEntry.fastMode).toBeUndefined();
  });

  it("persists and reports elevated-mode directives when allowed", async () => {
    const sessionEntry = createSessionEntry();
    const base = {
      elevatedAllowed: true,
      elevatedEnabled: true,
      sessionEntry,
    } satisfies Partial<HandleParams>;

    const onReply = await runHandleCommand("/elevated on", base);
    expect(onReply?.text).toContain("Elevated mode set to ask");
    expect(sessionEntry.elevatedLevel).toBe("on");

    const statusReply = await runHandleCommand("/elevated", {
      ...base,
      currentElevatedLevel: sessionEntry.elevatedLevel as ElevatedLevel | undefined,
    });
    expect(statusReply?.text).toContain("Current elevated level: on");

    const offReply = await runHandleCommand("/elevated off", {
      ...base,
      currentElevatedLevel: sessionEntry.elevatedLevel as ElevatedLevel | undefined,
    });
    expect(offReply?.text).toContain("Elevated mode disabled");
    expect(sessionEntry.elevatedLevel).toBe("off");
  });

  it("queues system events for elevated and reasoning mode directives", async () => {
    const sessionEntry = createSessionEntry();

    await runHandleCommand("/elevated on", {
      elevatedAllowed: true,
      elevatedEnabled: true,
      sessionEntry,
    });

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Elevated ASK - exec runs on host; approvals may still apply.",
      {
        sessionKey,
        contextKey: "mode:elevated",
      },
    );

    vi.mocked(enqueueSystemEvent).mockClear();

    await runHandleCommand("/reasoning stream", { sessionEntry });

    expect(enqueueSystemEvent).toHaveBeenCalledWith("Reasoning STREAM - emit live <think>.", {
      sessionKey,
      contextKey: "mode:reasoning",
    });
  });

  it.each([
    {
      command: EXEC_DEFAULTS_DIRECTIVE,
      acknowledgement: "Exec policy for this run only (security=allowlist, ask=always).",
      fields: ["execHost", "execNode"],
    },
    {
      command: VERBOSE_DEFAULT_DIRECTIVE,
      acknowledgement: "Verbose logging set for the current reply only.",
      fields: ["verboseLevel"],
    },
  ] as const)(
    "blocks internal operator.write persistence for $command",
    async ({ command, acknowledgement, fields }) => {
      const sessionEntry = createSessionEntry();
      const result = await runHandleCommand(command, {
        sessionEntry,
        surface: "webchat",
        gatewayClientScopes: ["operator.write"],
      });

      expect(result?.text).toContain(acknowledgement);
      expect(result?.text).toContain("operator.admin");
      for (const field of fields) {
        expect(sessionEntry[field]).toBeUndefined();
      }
    },
  );

  it("acknowledges run-only exec policy and persists admin-authorized placement", async () => {
    const sessionEntry = createSessionEntry();
    const initialEntry = { ...sessionEntry };
    const result = await runHandleCommand(EXEC_DEFAULTS_DIRECTIVE, {
      sessionEntry,
      surface: "webchat",
      gatewayClientScopes: ["operator.admin"],
    });

    expect(result?.text).toContain(
      "Exec policy for this run only (security=allowlist, ask=always).",
    );
    expect(result?.text).toContain("Exec defaults set (host=node, node=worker-1).");
    expect(sessionEntry).toEqual({
      ...initialEntry,
      execHost: "node",
      execNode: "worker-1",
      updatedAt: expect.any(Number),
    });
  });
});

describe("canonical session directive persistence policy", () => {
  it("checks an explicit same-value model selection against persisted state", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-inline-model-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionKey = "agent:main:dm:same-model";
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
    });
    const concurrentEntry: SessionEntry = {
      ...sessionEntry,
      updatedAt: sessionEntry.updatedAt + 1,
      modelOverride: "gpt-5.5",
    };
    await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);
    const directives = parseInlineSessionDirectives("hello /model openai/gpt-4o");

    try {
      const result = await handleDirectiveOnly(
        createDirectiveHandlingParams({
          directives,
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
          storePath,
          allowedModelKeys: new Set(["openai/gpt-4o"]),
          allowedModelCatalog: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
          provider: "openai",
          model: "gpt-4o",
          initialModelLabel: "openai/gpt-4o",
        }),
      );

      expect(result?.text).toContain("Model change was not applied");
      expect(result?.isError).toBe(true);
      expect(sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "unauthorized with empty scopes",
      policy: { gatewayClientScopes: [] },
      persisted: false,
    },
    {
      name: "authorized with webchat surface metadata",
      policy: {
        surface: "webchat",
        gatewayClientScopes: ["operator.write"],
        commandAuthorized: true,
      },
      persisted: true,
    },
  ])("applies external provider authority for $name", async ({ policy, persisted }) => {
    const sessionEntry = await persistInternalOperatorWriteDirective(
      EXEC_DEFAULTS_DIRECTIVE,
      externalChannelPolicy(policy),
    );

    expectExecDefaults(sessionEntry, persisted);
  });

  it("keeps internal provider authoritative over authorized external surface metadata", async () => {
    const sessionEntry = await persistInternalOperatorWriteDirective(VERBOSE_DEFAULT_DIRECTIVE, {
      messageProvider: "webchat",
      surface: "telegram",
      gatewayClientScopes: ["operator.write"],
      commandAuthorized: true,
    });

    expect(sessionEntry.verboseLevel).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
