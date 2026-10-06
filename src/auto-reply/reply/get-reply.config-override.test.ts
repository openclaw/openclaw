import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { resolveModelRefFromString } from "../../agents/model-selection-shared.js";
import type { PreparedReplyDispatchRuntime } from "../../agents/prepared-model-runtime.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/config.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../../config/sessions/session-diff-baseline-capture.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  expectResolvedTelegramTimezone,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import "./get-reply.test-runtime-mocks.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { SessionResetCleanupError } from "./session-reset-cleanup.js";

type CaptureSessionDiffBaseline =
  typeof import("../../sessions/session-diff.js").captureSessionDiffBaseline;
type DirectiveOverrides = Partial<Parameters<typeof createGetReplyContinueDirectivesResult>[0]>;
const mocks = vi.hoisted(() => ({
  captureBaseline: vi.fn<CaptureSessionDiffBaseline>(),
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
}));
registerGetReplyRuntimeOverrides(mocks);
const { getReplyFromConfig } = await import("../../plugin-sdk/reply-runtime.js");
const { getRuntimeConfig: loadConfigMock } = await import("../../config/config.js");
const { runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js");
const { resolveDefaultModel: resolveDefaultModelMock } =
  await import("./directive-handling.defaults.js");
const { resolveModelRefFromString: resolveModelRefFromStringMock } =
  await import("../../agents/model-selection.js");
const defaultImplementation = vi.mocked(resolveDefaultModelMock).getMockImplementation();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const defaultSessionKey = "agent:main:telegram:123";
const resolvedConfig: OpenClawConfig = {
  channels: { telegram: { botToken: "resolved-telegram-token" } },
  agents: { defaults: { userTimezone: "America/New_York" } },
};

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  vi.mocked(loadConfigMock).mockReset().mockReturnValue({});
  vi.mocked(runPreparedReplyMock).mockReset();
  vi.mocked(resolveModelRefFromStringMock).mockReset().mockReturnValue(null);
  vi.mocked(resolveDefaultModelMock).mockReset();
  if (defaultImplementation) {
    vi.mocked(resolveDefaultModelMock).mockImplementation(defaultImplementation);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function seedSession(
  entry: InternalSessionEntry,
  {
    sessionKey = defaultSessionKey,
    snapshot = false,
    body,
  }: { sessionKey?: string; snapshot?: boolean; body?: string } = {},
) {
  const storePath = path.join(tempDirs.make("get-reply-session-"), "sessions.json");
  await replaceSessionEntry({ sessionKey, storePath }, entry);
  const sessionEntryHandle = { replaceCurrent: vi.fn() };
  const fixture = createGetReplySessionState({
    sessionKey,
    sessionEntry: entry,
    sessionStore: { [sessionKey]: entry },
    storePath,
    ...(snapshot
      ? { initialSessionEntry: entry, sessionEntryHandle, sessionId: entry.sessionId }
      : {}),
    ...(body === undefined ? {} : { triggerBodyNormalized: body, bodyStripped: body }),
  });
  return { fixture, sessionKey, storePath, sessionEntryHandle };
}
function continueDirectives(body: string, sessionKey: string, overrides: DirectiveOverrides = {}) {
  return createGetReplyContinueDirectivesResult({
    body,
    abortKey: sessionKey,
    from: "telegram:user:42",
    to: "telegram:123",
    senderId: "telegram:user:42",
    commandSource: "text",
    senderIsOwner: true,
    resetHookTriggered: false,
    ...overrides,
  });
}
async function prepareBaselineClaimSession(sessionId: string) {
  const session = await seedSession(
    {
      createdVia: "operator",
      sessionId,
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
      updatedAt: Date.now(),
    },
    { sessionKey: `agent:main:telegram:${sessionId}`, snapshot: true },
  );
  mocks.initSessionState.mockResolvedValueOnce(session.fixture);
  const ctx = buildGetReplyCtx({ SessionKey: session.sessionKey });
  return { ...session, ctx };
}
function createPreparedDispatchRuntime(
  overrides: Partial<PreparedReplyDispatchRuntime> = {},
): PreparedReplyDispatchRuntime {
  return Object.freeze({
    agentId: "main",
    agentDir: "/tmp/prepared-model-owner",
    workspaceDir: "/tmp/prepared-model-workspace",
    config: {
      ...resolvedConfig,
      agents: { ...resolvedConfig.agents, entries: { main: {} } },
    },
    modelCatalog: { entries: [], routeVariants: [] },
    inboundPluginRegistry: createEmptyPluginRegistry(),
    pluginGeneration: {} as never,
    ...overrides,
  });
}

describe("getReplyFromConfig configOverride", () => {
  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    const sessionDiff = await import("../../sessions/session-diff.js");
    const commands = await import("./commands.runtime.js");
    vi.spyOn(sessionDiff, "captureSessionDiffBaseline").mockImplementation(mocks.captureBaseline);
    vi.spyOn(commands, "handleCommands").mockResolvedValue({ shouldContinue: true });
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    const session = await seedSession(
      { sessionId: "session-1", updatedAt: Date.now() },
      { snapshot: true },
    );
    mocks.initSessionState.mockResolvedValue(session.fixture);
    mocks.captureBaseline.mockImplementation(async ({ sessionId }) => ({
      version: 1,
      sessionId,
      root: "/workspace",
      files: [],
    }));
  });

  it("rejects forged operator authority at the public SDK reply entry", async () => {
    const assertCurrent = vi.fn();
    const plain = { profileId: "guest", scopes: ["operator.admin"], assertCurrent };
    const issued = createAdmittedRunOperatorAuthority(plain);
    for (const operatorAuthority of [plain, { ...issued }]) {
      const options = { runId: "forged-operator", operatorAuthority };
      await expect(getReplyFromConfig(buildGetReplyCtx(), options, {})).rejects.toThrow(
        "operator run authority must be issued by the host",
      );
    }
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
  });
  it("pins the issued operator source once through public reply option copies", async () => {
    const issued = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    let reads = 0;
    const options = {
      runId: "issued-operator",
      get operatorAuthority() {
        reads += 1;
        return reads === 1 ? issued : { ...issued, scopes: ["operator.admin"] };
      },
    };
    await expect(getReplyFromConfig(buildGetReplyCtx(), options, {})).resolves.toEqual({
      text: "ok",
    });
    expect(reads).toBe(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({ opts: expect.objectContaining({ operatorAuthority: issued }) }),
    );
  });
  it("merges configOverride over fresh getRuntimeConfig()", async () => {
    vi.mocked(loadConfigMock).mockReturnValue({
      ...resolvedConfig,
      agents: { defaults: { userTimezone: "UTC" } },
    });
    await getReplyFromConfig(buildGetReplyCtx(), undefined, {
      agents: { defaults: { userTimezone: "America/New_York" } },
    });
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
  });
  it("reports reset cleanup failure without starting the reply", async () => {
    const message = "Reset did not complete. Inspect remaining tasks and retry /reset.";
    mocks.initSessionState.mockRejectedValueOnce(new SessionResetCleanupError(message));
    const runState: ReplyOperationRunState = {};
    const opts: InternalGetReplyOptions = { [REPLY_OPERATION_RUN_STATE]: runState };
    await expect(getReplyFromConfig(buildGetReplyCtx(), opts, {})).resolves.toEqual({
      text: message,
    });
    expect(runState.preRunRejection).toBe("session-directive-rejected");
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
  });
  it("rethrows baseline work-start invalidation before reply execution", async () => {
    const { ctx } = await prepareBaselineClaimSession("invalidated-get-reply");
    mocks.captureBaseline.mockRejectedValueOnce(
      new SessionWorkStartInvalidatedError("session changed during baseline capture"),
    );
    await expect(getReplyFromConfig(ctx, undefined, {})).rejects.toBeInstanceOf(
      SessionWorkStartInvalidatedError,
    );
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
  });
  it("uses the admitted catalog through the native SDK resolver", async () => {
    const preparedRuntime = createPreparedDispatchRuntime();
    vi.mocked(loadConfigMock).mockImplementation(() => {
      throw new Error("getRuntimeConfig should not be called for a prepared Gateway dispatch");
    });
    const body = "/model ollama/picker-secondary -s";
    await bindPreparedReplyDispatchRuntime(
      preparedRuntime,
      getReplyFromConfig,
    )(
      buildGetReplyCtx({
        Body: body,
        RawBody: body,
        CommandBody: body,
        CommandSource: "native",
        CommandAuthorized: true,
        CommandTargetSessionKey: defaultSessionKey,
      }),
    );
    expect(loadConfigMock).not.toHaveBeenCalled();
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        agentDir: "/tmp/prepared-model-owner",
        workspaceDir: "/tmp/prepared-model-workspace",
        preparedModelCatalog: preparedRuntime.modelCatalog,
      }),
    );
  });
  it("rejects a prepared dispatch runtime that crosses the admitted session agent", async () => {
    const preparedRuntime = createPreparedDispatchRuntime({
      agentId: "worker",
      config: { agents: { entries: { worker: {} } } },
    });
    await expect(
      bindPreparedReplyDispatchRuntime(preparedRuntime, getReplyFromConfig)(buildGetReplyCtx()),
    ).rejects.toThrow("reply model catalog owner changed from main to worker");
  });
});

function makeTestModel(id: string, name: string, reasoning: boolean): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}
function makeReasoningModelConfig(
  thinking?: false | "high",
  filterPrimary = false,
): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        workspace: "/tmp/workspace",
        ...(thinking === undefined
          ? {}
          : { models: { "openai/gpt-5.5": { params: { thinking } } } }),
        ...(filterPrimary ? { modelPolicy: { allow: ["anthropic/*"] } } : {}),
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1",
          models: [makeTestModel("gpt-5.5", "GPT-5.5", true)],
        },
        anthropic: {
          baseUrl: "https://api.anthropic.test/v1",
          models: [makeTestModel("claude-fallback", "Claude Fallback", false)],
        },
      },
    },
  });
}
async function mockAutoFallbackSession(modelSelectionLocked?: boolean) {
  const session = await seedSession(
    {
      sessionId: "fallback-session",
      updatedAt: Date.now(),
      providerOverride: "anthropic",
      modelOverride: "claude-fallback",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-5.5",
      modelSelectionLocked,
    },
    { body: "hello" },
  );
  mocks.initSessionState.mockResolvedValue(session.fixture);
  return session;
}
function mockFallbackDirectiveResult(sessionKey: string, overrides: DirectiveOverrides = {}) {
  mocks.resolveReplyDirectives.mockImplementation(async () =>
    continueDirectives("hello", sessionKey, {
      provider: "anthropic",
      model: "claude-fallback",
      ...overrides,
    }),
  );
}
function runParams() {
  return vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
}
async function expectPreparedReply(cfg: OpenClawConfig, options?: InternalGetReplyOptions) {
  await expect(getReplyFromConfig(buildGetReplyCtx(), options, cfg)).resolves.toEqual({
    text: "ok",
  });
  expect(runPreparedReplyMock).toHaveBeenCalledOnce();
  return runParams();
}

describe("getReplyFromConfig auto-fallback primary probes", () => {
  beforeEach(async () => {
    delete process.env.OPENCLAW_TEST_FAST;
    const catalog = await import("../../agents/model-catalog.runtime.js");
    vi.spyOn(catalog, "loadProviderScopedThinkingCatalog").mockResolvedValue([]);
    vi.spyOn(catalog, "loadPreparedModelCatalogSnapshot").mockResolvedValue({
      entries: [],
      routeVariants: [],
      authoritative: true,
    });
    vi.mocked(resolveDefaultModelMock).mockReturnValue({
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
    });
    vi.mocked(resolveModelRefFromStringMock).mockImplementation(resolveModelRefFromString);
    mocks.handleInlineActions.mockImplementation(
      async (params: { directives?: unknown; cleanedBody?: string }) => ({
        kind: "continue",
        directives: params.directives ?? {},
        cleanedBody: params.cleanedBody ?? "hello",
        abortedLastRun: false,
      }),
    );
    vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
  });
  it("suppresses heartbeat model overrides for a model-locked session", async () => {
    const { sessionKey } = await mockAutoFallbackSession(true);
    mockFallbackDirectiveResult(sessionKey, { resolvedThinkLevel: "off" });
    await expectPreparedReply(makeReasoningModelConfig(), {
      isHeartbeat: true,
      heartbeatModelOverride: "openai/gpt-5.5@openai:metered",
    });
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledOnce();
    expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-fallback",
      hasResolvedHeartbeatModelOverride: false,
    });
    expect(runParams()).toMatchObject({ provider: "anthropic", model: "claude-fallback" });
    expect(runParams()?.autoFallbackPrimaryProbe).toBeUndefined();
    expect(runParams()).not.toHaveProperty("configuredProfileId", "openai:metered");
  });
  it("keeps an explicit heartbeat profile on its turn without persisting it into chat", async () => {
    const { sessionKey, storePath } = await mockAutoFallbackSession();
    mockFallbackDirectiveResult(sessionKey, { provider: "openai", model: "gpt-5.5" });
    const cfg = makeReasoningModelConfig();
    await getReplyFromConfig(
      buildGetReplyCtx(),
      { isHeartbeat: true, heartbeatModelOverride: "openai/gpt-5.5@openai:metered" },
      cfg,
    );
    expect(runParams()).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      configuredProfileId: "openai:metered",
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.authProfileOverride).toBeUndefined();
    await getReplyFromConfig(buildGetReplyCtx(), undefined, cfg);
    expect(vi.mocked(runPreparedReplyMock).mock.calls[1]?.[0]).not.toHaveProperty(
      "configuredProfileId",
      "openai:metered",
    );
  });
  it.each([
    ["turn override", undefined, "off"],
    ["per-model off", false, "off"],
    ["per-model high", "high", "high"],
  ] as const)(
    "honors %s and clears fallback reasoning during primary probes",
    async (_name, thinking, expected) => {
      const { sessionKey } = await mockAutoFallbackSession();
      mockFallbackDirectiveResult(sessionKey, {
        resolvedThinkLevel: "off",
        resolvedReasoningLevel: thinking === undefined ? undefined : "on",
      });
      const prepared = await expectPreparedReply(
        makeReasoningModelConfig(thinking),
        thinking === undefined ? { thinkingLevelOverride: "off" } : undefined,
      );
      expect(prepared).toMatchObject({
        provider: "openai",
        model: "gpt-5.5",
        resolvedThinkLevel: expected,
        resolvedReasoningLevel: "off",
      });
    },
  );
  it("uses the policy-selected model defaults when the primary probe is filtered out", async () => {
    const { sessionKey } = await mockAutoFallbackSession();
    mockFallbackDirectiveResult(sessionKey, { resolvedThinkLevel: "off" });
    const catalogRuntime = await import("../../agents/model-catalog.runtime.js");
    const catalog = [
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", reasoning: true },
      { provider: "anthropic", id: "claude-fallback", name: "Claude Fallback", reasoning: false },
    ];
    vi.mocked(catalogRuntime.loadPreparedModelCatalogSnapshot).mockResolvedValueOnce({
      entries: catalog,
      routeVariants: catalog,
      authoritative: true,
    });
    const prepared = await expectPreparedReply(makeReasoningModelConfig("high", true));
    expect(prepared?.modelState).toMatchObject({
      provider: "anthropic",
      model: "claude-fallback",
    });
    expect(prepared).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
    });
  });
});
