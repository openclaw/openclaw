import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { FAST_RESET_LINEAGE_FIXTURE } from "../../config/sessions/session-lineage.test-support.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target-paths.js";
import { isPathInside } from "../../infra/path-guards.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import { handleGoalCommand } from "./commands-goal.js";
import type { CommandDispatchParams } from "./commands-types.js";
import { initFastReplySessionState } from "./get-reply-fast-path.js";
import { emptyAliasIndex, markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyCtx,
  createGetReplyContinueDirectivesResult,
  registerGetReplyBaselineBypass,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import "./get-reply.test-runtime-mocks.js";

registerGetReplyBaselineBypass();
type LoadModelCatalogFn =
  typeof import("../../agents/prepared-model-catalog.js").readPreparedModelCatalog;
const mocks = vi.hoisted(() => ({
  buildStatusReply: vi.fn(),
  ensureAgentWorkspace: vi.fn(),
  handleCommands: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  loadModelCatalog: vi.fn<LoadModelCatalogFn>(),
  resolveReplyDirectives: vi.fn(),
}));
vi.mock("./commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands.js")>()),
  handleCommands: mocks.handleCommands,
}));
// mock-isolation: Supply deterministic status output without invoking live status providers.
vi.mock("./commands-status.js", () => ({
  buildStatusReply: mocks.buildStatusReply,
}));
vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: mocks.loadModelCatalog,
}));
// mock-isolation: Use a synthetic workspace inventory without reading operator workspace files.
vi.mock("../../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/openclaw-workspace",
  ensureAgentWorkspace: mocks.ensureAgentWorkspace,
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let loadConfigMock: typeof import("../../config/config.js").getRuntimeConfig;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;
const sessionKey = "agent:main:telegram:123";

function commandCtx(body: string, overrides: Partial<MsgContext> = {}) {
  return buildGetReplyCtx({ Body: body, RawBody: body, CommandBody: body, ...overrides });
}
function nativeCtx(body: string, overrides: Partial<MsgContext> = {}) {
  return commandCtx(body, {
    BodyForAgent: body,
    CommandSource: "native",
    CommandAuthorized: true,
    SessionKey: "telegram:slash:123",
    CommandTargetSessionKey: sessionKey,
    ...overrides,
  });
}
function preparedReply() {
  return expectDefined(vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0], "prepared reply params");
}
function expectNoBootstrap() {
  expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  expect(mocks.initSessionState).not.toHaveBeenCalled();
  expect(runPreparedReplyMock).not.toHaveBeenCalled();
}
function expectNativePayload(reply: Awaited<ReturnType<typeof getReplyFromConfig>>, text: string) {
  const payload = expectDefined(Array.isArray(reply) ? undefined : reply, "single native reply");
  expect(payload.text).toContain(text);
  expect(getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression).toBe(true);
  expectNoBootstrap();
}

describe("getReplyFromConfig fast test bootstrap", () => {
  let state: OpenClawTestState;
  let storePath: string;
  const config = (model = "openai/gpt-5.5", heartbeat?: Record<string, never>) =>
    markCompleteReplyConfig({
      agents: {
        defaults: { model, workspace: state.workspaceDir, ...(heartbeat ? { heartbeat } : {}) },
      },
      session: { store: storePath },
    });
  const seedSession = (entry: Pick<SessionEntry, "sessionId"> & Partial<SessionEntry>) =>
    replaceSessionEntry({ storePath, sessionKey }, { updatedAt: Date.now(), ...entry });
  const readSession = () =>
    expectDefined(loadSessionEntry({ storePath, sessionKey }), "stored fast-path session");
  const bootstrap = (
    ctx = commandCtx("/reset", { SessionKey: sessionKey }),
    resetTriggers?: string[],
  ) =>
    initFastReplySessionState({
      ctx,
      cfg: { session: { store: storePath, resetTriggers } },
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: state.workspaceDir,
    });

  beforeAll(async () => {
    ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
    ({ resolveDefaultModel: resolveDefaultModelMock } =
      await import("./directive-handling.defaults.js"));
    ({ getRuntimeConfig: loadConfigMock } = await import("../../config/config.js"));
    ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
  });
  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "fast-reply",
      env: { OPENCLAW_TEST_FAST: "1" },
    });
    storePath = path.join(state.sessionsDir("main"), "sessions.json");
    expect(
      isPathInside(state.root, resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath).path),
    ).toBe(true);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [],
    });
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.buildStatusReply.mockImplementation(
      async (status: {
        resolvedThinkLevel?: string;
        resolveDefaultThinkingLevel: () => Promise<string | undefined>;
      }) => ({
        text: `OpenClaw\nThink: ${status.resolvedThinkLevel ?? (await status.resolveDefaultThinkingLevel()) ?? "off"}`,
      }),
    );
    mocks.handleCommands.mockImplementation(
      async (params: CommandDispatchParams) =>
        (await handleGoalCommand({ ...params, ...(await params.resolveModelLevels()) }, true)) ?? {
          shouldContinue: true,
          reply: undefined,
        },
    );
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.loadModelCatalog.mockResolvedValue([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", reasoning: true },
    ]);
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    vi.mocked(resolveDefaultModelMock).mockReset().mockReturnValue({
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: emptyAliasIndex(),
    });
    vi.mocked(loadConfigMock).mockReset().mockReturnValue({});
    vi.mocked(runPreparedReplyMock).mockReset().mockResolvedValue({ text: "ok" });
  });
  afterEach(async () => {
    await state.cleanup();
    setActivePluginRegistry(createTestRegistry([]));
    cliBackendsTesting.resetDepsForTest();
    vi.unstubAllEnvs();
  });

  it("fails fast on unmarked config overrides in strict fast-test mode", async () => {
    await expect(getReplyFromConfig(buildGetReplyCtx(), undefined, {})).rejects.toThrow(
      /withFastReplyConfig\(\)\/markCompleteReplyConfig\(\)/,
    );
    expect(vi.mocked(loadConfigMock)).not.toHaveBeenCalled();
  });

  it("returns a clean rejection when session bootstrap rejects a locked reset", async () => {
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.initSessionState.mockRejectedValueOnce(
      new ModelSelectionLockedError(MODEL_SELECTION_LOCKED_RESET_MESSAGE),
    );
    const runState: ReplyOperationRunState = {};
    const opts: InternalGetReplyOptions = { [REPLY_OPERATION_RUN_STATE]: runState };
    const result = await getReplyFromConfig(
      commandCtx("/reset openai/gpt-5.5 continue", { CommandAuthorized: true }),
      opts,
      {},
    );
    expect(result).toEqual({ text: MODEL_SELECTION_LOCKED_RESET_MESSAGE });
    expect(runState.preRunRejection).toBe("model-selection-locked");
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
  });

  it.each([
    ["clears stale ack-only heartbeat pending delivery", "HEARTBEAT_OK", true],
    [
      "does not replay private pending delivery during heartbeat",
      "private prior user answer",
      false,
    ],
  ] as const)("%s", async (_name, text, cleared) => {
    await seedSession({
      sessionId: "pending-final",
      updatedAt: Date.now() - (cleared ? 0 : 60_000),
      pendingFinalDelivery: {
        kind: "replayable",
        text,
        createdAt: 1,
        intentId: "stale-heartbeat-intent",
      },
    });
    await expect(
      getReplyFromConfig(buildGetReplyCtx(), { isHeartbeat: true }, config("openai/gpt-5.5", {})),
    ).resolves.toEqual({ text: "ok" });
    if (cleared) {
      expect(readSession().pendingFinalDelivery).toBeUndefined();
    } else {
      expect(readSession().pendingFinalDelivery).toMatchObject({ kind: "replayable", text });
    }
  });

  it("uses the target session thinking override for native /status", async () => {
    await seedSession({
      sessionId: "existing-telegram-session",
      thinkingLevel: "xhigh",
      updatedAt: 1,
    });
    vi.mocked(resolveDefaultModelMock).mockReturnValueOnce({
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: emptyAliasIndex(),
    });
    const cfg = config();
    expectNativePayload(
      await getReplyFromConfig(nativeCtx("/status"), undefined, cfg),
      "OpenClaw\nThink: xhigh",
    );
    expect(mocks.loadModelCatalog).toHaveBeenCalledExactlyOnceWith({
      config: cfg,
      agentId: "main",
      agentDir: state.agentDir("main"),
      workspaceDir: state.workspaceDir,
      readOnly: true,
    });
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
  });

  it("handles native slash directives before workspace bootstrap", async () => {
    mocks.resolveReplyDirectives.mockResolvedValueOnce({
      kind: "reply",
      reply: { text: "model status" },
    });
    const result = await getReplyFromConfig(
      nativeCtx("/model status", {
        SessionCreation: {
          via: "operator",
          actor: { type: "human", source: "profile", id: "profile-native-slash" },
        },
      }),
      undefined,
      config("anthropic/claude-opus-4-6"),
    );
    expect(result).toMatchObject({ text: "model status" });
    expectNativePayload(result, "model status");
    expect(mocks.handleCommands).toHaveBeenCalledOnce();
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionKey, workspaceDir: state.workspaceDir }),
    );
    expect((await listSessionStateEventsSince(sessionKey, "main", 0, 20)).events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        actorType: "human",
        actorId: "profile-native-slash",
      }),
    );
  });

  it("continues native slash goal starts with the rewritten command-safe prompt", async () => {
    const continuationPrompt = `Pursue this goal exactly as written from this JSON string: "\\/status"`;
    const continueDirectives = async ({
      triggerBodyNormalized,
    }: {
      triggerBodyNormalized: string;
    }) =>
      createGetReplyContinueDirectivesResult({
        body: triggerBodyNormalized,
        commandSource: triggerBodyNormalized,
        abortKey: sessionKey,
        from: "telegram:user:42",
        to: "telegram:123",
        senderId: "telegram:user:42",
        senderIsOwner: true,
        resetHookTriggered: false,
      });
    mocks.resolveReplyDirectives
      .mockImplementationOnce(continueDirectives)
      .mockImplementationOnce(async (params: { triggerBodyNormalized: string }) => {
        expect(params.triggerBodyNormalized).toBe(continuationPrompt);
        return continueDirectives(params);
      });
    mocks.handleInlineActions.mockImplementation(async (params: unknown) => {
      expect(params).toMatchObject({
        command: {
          rawBodyNormalized: continuationPrompt,
          commandBodyNormalized: continuationPrompt,
        },
        cleanedBody: continuationPrompt,
      });
      return {
        kind: "continue",
        directives: {},
        abortedLastRun: false,
        cleanedBody: continuationPrompt,
      };
    });
    const onSessionMetadataChanges = vi.fn();
    const opts: InternalGetReplyOptions = { onSessionMetadataChanges };
    await expect(
      getReplyFromConfig(
        nativeCtx("/goal start /status"),
        opts,
        config("anthropic/claude-opus-4-6"),
      ),
    ).resolves.toEqual({ text: "ok" });
    expect(onSessionMetadataChanges).toHaveBeenCalledWith([
      { sessionKey, agentId: "main", reason: "command-metadata" },
    ]);
    expect(onSessionMetadataChanges.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        vi.mocked(runPreparedReplyMock).mock.invocationCallOrder[0],
        "prepared reply call order",
      ),
    );
    expect(readSession().goal?.objective).toBe("/status");
    expect(preparedReply()).toMatchObject({
      command: { commandBodyNormalized: continuationPrompt },
      sessionCtx: { BodyForAgent: continuationPrompt },
    });
    expect(mocks.handleInlineActions).toHaveBeenCalledTimes(2);
  });

  it("preserves the exact multiline reset payload during fast bootstrap", async () => {
    const payload = "keep [Q3]\nline 2";
    const result = await bootstrap(
      buildGetReplyCtx({
        Body: `/new ${payload}`,
        BodyForCommands: `/new ${payload}`,
        RawBody: `[Telegram id:456] İpek: /NEW: ${payload}`,
        SenderName: "İpek",
        SessionKey: sessionKey,
      }),
      ["/new"],
    );
    expect(result).toMatchObject({
      resetTriggered: true,
      bodyStripped: payload,
      sessionCtx: { agentText: payload },
    });
  });

  it("preserves node provenance, lineage, and usage preferences during fast reset bootstrap", async () => {
    const preserved = { ...FAST_RESET_LINEAGE_FIXTURE, responseUsage: "full" as const };
    await seedSession({ sessionId: "existing-fast-reset-lineage", ...preserved });
    const result = await bootstrap();
    expect(result).toMatchObject({
      resetTriggered: true,
      sessionEntry: { previousSessionId: "existing-fast-reset-lineage", ...preserved },
    });
  });

  it("rejects a fast reset bootstrap for a model-locked session", async () => {
    const entry = {
      sessionId: "existing-fast-reset-locked",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    };
    await seedSession(entry);
    await expect(bootstrap()).rejects.toThrow(MODEL_SELECTION_LOCKED_RESET_MESSAGE);
    expect(readSession()).toMatchObject(entry);
  });
});
