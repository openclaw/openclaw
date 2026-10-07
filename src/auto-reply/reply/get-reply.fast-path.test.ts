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
  createGetReplySessionState,
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
vi.mock("./commands.runtime.js", () => ({
  handleCommands: (...args: unknown[]) => mocks.handleCommands(...args),
}));
vi.mock("./commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => mocks.buildStatusReply(...args),
}));
vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: mocks.loadModelCatalog,
}));
vi.mock("../../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/openclaw-workspace",
  ensureAgentWorkspace: (...args: unknown[]) => mocks.ensureAgentWorkspace(...args),
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfigInternal: typeof import("./get-reply.js").getReplyFromConfigInternal;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let resolveModelRefFromStringMock: typeof import("../../agents/model-selection.js").resolveModelRefFromString;
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
  expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
}

describe("getReplyFromConfigInternal fast test bootstrap", () => {
  let state: OpenClawTestState;
  let storePath: string;
  const config = (model = "openai/gpt-5.5") =>
    markCompleteReplyConfig({
      agents: {
        defaults: { model, workspace: state.workspaceDir },
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
    ({ getReplyFromConfigInternal } = await loadGetReplyModuleForTest({
      cacheKey: import.meta.url,
    }));
    ({ resolveDefaultModel: resolveDefaultModelMock } =
      await import("./directive-handling.defaults.js"));
    ({ resolveModelRefFromString: resolveModelRefFromStringMock } =
      await import("../../agents/model-selection.js"));
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
    mocks.initSessionState.mockResolvedValue(createGetReplySessionState());
    vi.mocked(resolveDefaultModelMock).mockReset().mockReturnValue({
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: emptyAliasIndex(),
    });
    vi.mocked(resolveModelRefFromStringMock).mockReset().mockReturnValue(null);
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
    await expect(getReplyFromConfigInternal(buildGetReplyCtx(), undefined, {})).rejects.toThrow(
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
    const result = await getReplyFromConfigInternal(
      commandCtx("/reset openai/gpt-5.5 continue", {
        CommandAuthorized: true,
        SessionKey: sessionKey,
      }),
      opts,
      {},
    );
    expect(result).toEqual({ text: MODEL_SELECTION_LOCKED_RESET_MESSAGE });
    expect(runState.preRunRejection).toBe("model-selection-locked");
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
  });

  it("does not replay an earlier user final into an internal event", async () => {
    const text = "private prior user answer";
    await seedSession({
      sessionId: "pending-final",
      updatedAt: Date.now() - 60_000,
      pendingFinalDelivery: {
        kind: "replayable",
        text,
        createdAt: 1,
        intentId: "earlier-user-final",
      },
    });
    await expect(
      getReplyFromConfigInternal(
        buildGetReplyCtx({
          InputProvenance: { kind: "internal_system", sourceTool: "session-event" },
          InternalTurnSource: "event",
        }),
        undefined,
        config(),
      ),
    ).resolves.toEqual({ text: "ok" });
    expect(readSession().pendingFinalDelivery).toMatchObject({ kind: "replayable", text });
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
    const reply = await getReplyFromConfigInternal(nativeCtx("/status"), undefined, cfg);
    const payload = expectDefined(Array.isArray(reply) ? undefined : reply, "single status reply");
    expect(payload.text).toContain("OpenClaw");
    expect(payload.text).toContain("Think: xhigh");
    expect(getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(mocks.loadModelCatalog).toHaveBeenCalledExactlyOnceWith({
      config: cfg,
      agentId: "main",
      agentDir: state.agentDir("main"),
      workspaceDir: state.workspaceDir,
      readOnly: true,
    });
    expectNoBootstrap();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
  });

  it("handles native slash directives before workspace bootstrap", async () => {
    mocks.resolveReplyDirectives.mockResolvedValueOnce({
      kind: "reply",
      reply: { text: "model status" },
    });
    const reply = await getReplyFromConfigInternal(
      nativeCtx("/model status", {
        SessionCreation: {
          via: "operator",
          actor: { type: "human", source: "profile", id: "profile-native-slash" },
        },
      }),
      undefined,
      config("anthropic/claude-opus-4-6"),
    );
    expect(reply).toMatchObject({ text: "model status" });
    const payload = expectDefined(
      Array.isArray(reply) ? undefined : reply,
      "single directive reply",
    );
    expect(getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression).toBe(true);
    expectNoBootstrap();
    expect(mocks.handleCommands).toHaveBeenCalledOnce();
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledOnce();
    expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toMatchObject({
      sessionKey,
      workspaceDir: state.workspaceDir,
    });
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
      getReplyFromConfigInternal(
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
    expect(preparedReply().command.commandBodyNormalized).toBe(continuationPrompt);
    expect(preparedReply().sessionCtx.BodyForAgent).toBe(continuationPrompt);
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
    expect(result.resetTriggered).toBe(true);
    expect(result.bodyStripped).toBe(payload);
    expect(result.sessionCtx.agentText).toBe(payload);
  });

  it("preserves node provenance, lineage, and usage preferences during fast reset bootstrap", async () => {
    const preserved = { ...FAST_RESET_LINEAGE_FIXTURE, responseUsage: "full" as const };
    await seedSession({ sessionId: "existing-fast-reset-lineage", ...preserved });
    const result = await bootstrap();
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionEntry).toMatchObject({
      previousSessionId: "existing-fast-reset-lineage",
      ...preserved,
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
