import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { modelDefinition } from "../../agents/model-auth.fixtures.test-support.js";
import { resolveModelRefFromString } from "../../agents/model-selection-shared.js";
import type { PreparedReplyDispatchRuntime } from "../../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../../config/sessions/session-diff-baseline-capture.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyCtx as buildCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState as sessionState,
  expectResolvedTelegramTimezone,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import "./get-reply.test-runtime-mocks.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import { beforeSettlement, expectCallCounts } from "./reply-contract.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
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
const { getRuntimeConfig } = await import("../../config/config.js");
const loadConfig = vi.mocked(getRuntimeConfig);
const { runPreparedReply } = await import("./get-reply-run.js");
const runReply = vi.mocked(runPreparedReply);
const { resolveDefaultModel } = await import("./directive-handling.defaults.js");
const defaultModel = vi.mocked(resolveDefaultModel);
const { resolveModelRefFromString: modelResolver } =
  await import("../../agents/model-selection.js");
const resolveModel = vi.mocked(modelResolver);
const defaultImplementation = defaultModel.getMockImplementation();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const defaultSessionKey = "agent:main:telegram:123";
const primary = { provider: "openai", model: "gpt-5.5" };
const fallback = { provider: "anthropic", model: "claude-fallback" };
const modelCatalog = [
  { provider: primary.provider, id: primary.model, name: "GPT-5.5", reasoning: true },
  { provider: fallback.provider, id: fallback.model, name: "Claude Fallback", reasoning: false },
];
const resolvedConfig: OpenClawConfig = {
  channels: { telegram: { botToken: "resolved-telegram-token" } },
  agents: { defaults: { userTimezone: "America/New_York" } },
};
const baseline = (sessionId: string): Awaited<ReturnType<CaptureSessionDiffBaseline>> => ({
  version: 1,
  sessionId,
  root: "/workspace",
  files: [],
});

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of [...Object.values(mocks), loadConfig, runReply, resolveModel, defaultModel]) {
    mock.mockReset();
  }
  loadConfig.mockReturnValue({});
  resolveModel.mockReturnValue(null);
  if (defaultImplementation) {
    defaultModel.mockImplementation(defaultImplementation);
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
  const sessionEntryHandle = createReplySessionEntryHandle({ sessionEntry: entry, sessionKey });
  const fixture = sessionState({
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
function mockFallbackDirectiveResult(sessionKey: string, overrides: DirectiveOverrides = {}) {
  mocks.resolveReplyDirectives.mockImplementation(async () =>
    createGetReplyContinueDirectivesResult({
      body: "hello",
      abortKey: sessionKey,
      from: "telegram:user:42",
      to: "telegram:123",
      senderId: "telegram:user:42",
      commandSource: "text",
      senderIsOwner: true,
      resetHookTriggered: false,
      ...fallback,
      ...overrides,
    }),
  );
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
  const ctx = buildCtx({ SessionKey: session.sessionKey });
  return { ...session, ctx };
}
function createPreparedDispatchRuntime(
  overrides: Partial<PreparedReplyDispatchRuntime> = {},
): PreparedReplyDispatchRuntime {
  return Object.freeze({
    agentId: "main",
    agentDir: "/tmp/prepared-model-owner",
    workspaceDir: "/tmp/prepared-model-workspace",
    config: { ...resolvedConfig, agents: { ...resolvedConfig.agents, entries: { main: {} } } },
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
    const commands = await import("./commands.js");
    vi.spyOn(sessionDiff, "captureSessionDiffBaseline").mockImplementation(mocks.captureBaseline);
    vi.spyOn(commands, "handleCommands").mockResolvedValue({ shouldContinue: true });
    for (const mock of [mocks.handleInlineActions, mocks.resolveReplyDirectives]) {
      mock.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    }
    const session = await seedSession(
      { sessionId: "session-1", updatedAt: Date.now() },
      { snapshot: true },
    );
    mocks.initSessionState.mockResolvedValue(session.fixture);
    mocks.captureBaseline.mockImplementation(async ({ sessionId }) => baseline(sessionId));
  });

  it("rejects forged operator authority at the public SDK reply entry", async () => {
    const assertCurrent = vi.fn();
    const plain = { profileId: "guest", scopes: ["operator.admin"], assertCurrent };
    const issued = createAdmittedRunOperatorAuthority(plain);
    for (const operatorAuthority of [plain, { ...issued }]) {
      const options = { runId: "forged-operator", operatorAuthority };
      await expect(getReplyFromConfig(buildCtx(), options, {})).rejects.toThrow(
        "operator run authority must be issued by the host",
      );
    }
    expectCallCounts(0, assertCurrent, loadConfig, mocks.initSessionState, runReply);
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
    await expect(getReplyFromConfig(buildCtx(), options, {})).resolves.toEqual({ text: "ok" });
    expect(reads).toBe(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({ opts: expect.objectContaining({ operatorAuthority: issued }) }),
    );
  });
  it("merges configOverride over fresh getRuntimeConfig()", async () => {
    loadConfig.mockReturnValue({
      ...resolvedConfig,
      agents: { defaults: { userTimezone: "UTC" } },
    });
    await getReplyFromConfig(buildCtx(), undefined, { agents: resolvedConfig.agents });
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
  });
  it("reports reset cleanup failure without starting the reply", async () => {
    const message = "Reset did not complete. Inspect remaining tasks and retry /reset.";
    mocks.initSessionState.mockRejectedValueOnce(new SessionResetCleanupError(message));
    const runState: ReplyOperationRunState = {};
    const opts: InternalGetReplyOptions = { [REPLY_OPERATION_RUN_STATE]: runState };
    await expect(getReplyFromConfig(buildCtx(), opts, {})).resolves.toEqual({ text: message });
    expect(runState.preRunRejection).toBe("session-directive-rejected");
    expect(runReply).not.toHaveBeenCalled();
  });
  it("rethrows baseline work-start invalidation before reply execution", async () => {
    const { ctx } = await prepareBaselineClaimSession("invalidated-get-reply");
    mocks.captureBaseline.mockRejectedValueOnce(
      new SessionWorkStartInvalidatedError("session changed during baseline capture"),
    );
    await expect(getReplyFromConfig(ctx, undefined, {})).rejects.toBeInstanceOf(
      SessionWorkStartInvalidatedError,
    );
    expect(runReply).not.toHaveBeenCalled();
  });
  it("uses the admitted catalog through the native SDK resolver", async () => {
    const preparedRuntime = createPreparedDispatchRuntime();
    loadConfig.mockImplementation(() => {
      throw new Error("getRuntimeConfig should not be called for a prepared Gateway dispatch");
    });
    const body = "/model ollama/picker-secondary -s";
    await bindPreparedReplyDispatchRuntime(
      preparedRuntime,
      getReplyFromConfig,
    )(
      buildCtx({
        Body: body,
        RawBody: body,
        CommandBody: body,
        CommandSource: "native",
        CommandAuthorized: true,
        CommandTargetSessionKey: defaultSessionKey,
      }),
    );
    expect(loadConfig).not.toHaveBeenCalled();
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
      bindPreparedReplyDispatchRuntime(preparedRuntime, getReplyFromConfig)(buildCtx()),
    ).rejects.toThrow("reply model catalog owner changed from main to worker");
  });
});

function makeReasoningModelConfig(): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        workspace: "/tmp/workspace",
      },
    },
    models: {
      providers: Object.fromEntries(
        modelCatalog.map(
          ({ provider, ...model }) =>
            [
              provider,
              {
                baseUrl: `https://api.${provider}.test/v1`,
                models: [modelDefinition(model.id, { ...model, contextWindow: 128_000 })],
              },
            ] as const,
        ),
      ),
    },
  });
}
async function mockAutoFallbackSession(
  modelSelectionLocked?: boolean,
  overrides: DirectiveOverrides = {},
) {
  const session = await seedSession(
    {
      sessionId: "fallback-session",
      updatedAt: Date.now(),
      providerOverride: fallback.provider,
      modelOverride: fallback.model,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: primary.provider,
      modelOverrideFallbackOriginModel: primary.model,
      modelSelectionLocked,
    },
    { body: "hello" },
  );
  mocks.initSessionState.mockResolvedValue(session.fixture);
  mockFallbackDirectiveResult(session.sessionKey, { resolvedThinkLevel: "off", ...overrides });
  return session;
}
function runParams() {
  return runReply.mock.calls[0]?.[0];
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
    defaultModel.mockReturnValue({
      defaultProvider: primary.provider,
      defaultModel: primary.model,
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
    });
    resolveModel.mockImplementation(resolveModelRefFromString);
    mocks.handleInlineActions.mockImplementation(
      async (params: { directives?: unknown; cleanedBody?: string }) => ({
        kind: "continue",
        directives: params.directives ?? {},
        cleanedBody: params.cleanedBody ?? "hello",
        abortedLastRun: false,
      }),
    );
    runReply.mockResolvedValue({ text: "ok" });
  });
  it("starts the model before baseline capture and settles it before tools and cleanup", async ({
    signal,
  }) => {
    const { ctx, sessionKey, sessionEntryHandle } =
      await prepareBaselineClaimSession("overlapping-baseline");
    const capture = createDeferred<Awaited<ReturnType<CaptureSessionDiffBaseline>>>();
    const modelStarted = createDeferred();
    const events: string[] = [];
    const sessionDiff = await import("../../sessions/session-diff.js");
    vi.spyOn(sessionDiff, "captureSessionDiffBaseline").mockReturnValueOnce(capture.promise);
    mockFallbackDirectiveResult(sessionKey);
    runReply.mockImplementationOnce(async (params) => {
      events.push("model");
      const updated = {
        ...sessionEntryHandle.getCurrent()!,
        label: "set during model preparation",
      };
      sessionEntryHandle.replaceCurrent(updated);
      modelStarted.resolve();
      expect(params.opts?.awaitSessionDiffBaseline).toBeTypeOf("function");
      await params.opts?.awaitSessionDiffBaseline?.();
      events.push("tool");
      return { text: "ok" };
    });
    const reply = getReplyFromConfig(ctx, undefined, makeReasoningModelConfig());
    try {
      await beforeSettlement(modelStarted.promise, reply, signal, "model did not start");
      expect(events).toEqual(["model"]);
    } finally {
      capture.resolve(baseline("overlapping-baseline"));
      await reply.catch(() => undefined);
    }
    await expect(reply).resolves.toEqual({ text: "ok" });
    expect(events).toEqual(["model", "tool"]);
    expect(sessionEntryHandle.getCurrent()).toMatchObject({
      label: "set during model preparation",
      sessionDiffBaseline: { sessionId: "overlapping-baseline" },
    });
  });

  it.for([false, true])(
    "keeps a scheduled model override turn-local (locked=%s)",
    async (locked) => {
      const { sessionKey, storePath } = await mockAutoFallbackSession(
        locked,
        locked ? fallback : primary,
      );
      const { getReplyFromConfig: getInternalReply } = await import("./get-reply.js");
      const cfg = makeReasoningModelConfig();
      await expect(
        getInternalReply(buildCtx(), { modelOverride: "openai/gpt-5.5@openai:metered" }, cfg),
      ).resolves.toEqual({ text: "ok" });
      expect(runParams()).toMatchObject(
        locked ? fallback : { ...primary, configuredProfileId: "openai:metered" },
      );
      expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toMatchObject({
        hasResolvedTurnModelOverride: !locked,
      });
      expect(loadSessionEntry({ storePath, sessionKey })?.authProfileOverride).toBeUndefined();
      await getInternalReply(buildCtx(), undefined, cfg);
      expect(runReply.mock.calls[1]?.[0]).not.toHaveProperty(
        "configuredProfileId",
        "openai:metered",
      );
    },
  );
});
