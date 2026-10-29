import fs from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { waitForAbortSignal } from "../../infra/abort-signal.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { MsgContext } from "../templating.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyCtx,
  buildGetReplyGroupCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  createLockedReplyPreprocessingState,
  registerGetReplyBaselineBypass,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import "./get-reply.test-mocks.js";

registerGetReplyBaselineBypass();

const mocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn<
    (
      params: Parameters<
        typeof import("../../media-understanding/apply.js").applyMediaUnderstanding
      >[0],
    ) => Promise<ApplyMediaUnderstandingResult | undefined>
  >(async () => undefined),
  applyLinkUnderstanding: vi.fn(async (..._args: unknown[]) => undefined),
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async (..._args: unknown[]) => undefined),
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  resolveReplySessionPreprocessingState: vi.fn(),
}));

vi.mock("../../globals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../globals.js")>()),
  logVerbose: vi.fn(),
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: mocks.createInternalHookEvent,
  triggerInternalHook: mocks.triggerInternalHook,
}));
vi.mock("../../link-understanding/apply.runtime.js", () => ({
  applyLinkUnderstanding: mocks.applyLinkUnderstanding,
}));
vi.mock("../../media-understanding/apply.runtime.js", () => ({
  applyMediaUnderstanding: mocks.applyMediaUnderstanding,
}));
registerGetReplyRuntimeOverrides(mocks);

const { getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url });
const { resolveDefaultModel: defaultModel } = await import("./directive-handling.defaults.js");
const { runPreparedReply: runReply } = await import("./get-reply-run.js");
const { stageSandboxMedia: stageMedia } = await import("./stage-sandbox-media.js");
const scope = await import("../../agents/agent-scope.js");
const actualScope = await vi.importActual<typeof scope>("../../agents/agent-scope.js");
const actualHooks = await vi.importActual<typeof import("../../hooks/internal-hooks.js")>(
  "../../hooks/internal-hooks.js",
);

const model = { provider: "anthropic", model: "claude-opus-4-6" };
const sessionAndDirectives = [mocks.initSessionState, mocks.resolveReplyDirectives];
const hooks = [mocks.createInternalHookEvent, mocks.triggerInternalHook];
const emptyAliasIndex = () => ({ byAlias: new Map(), byKey: new Map() });
const defaultModelFacts = () => ({
  defaultProvider: "openai",
  defaultModel: "gpt-4o-mini",
  aliasIndex: emptyAliasIndex(),
});
const bodyFields = (body: string) => ({
  Body: body,
  BodyForAgent: body,
  RawBody: body,
  CommandBody: body,
});

function continueReply(
  ctx: MsgContext,
  overrides: Partial<Parameters<typeof createGetReplyContinueDirectivesResult>[0]> = {},
) {
  return createGetReplyContinueDirectivesResult({
    body: ctx.BodyForAgent ?? "read the document",
    abortKey: ctx.SessionKey ?? "agent:main:main",
    from: ctx.From ?? "webchat:operator",
    to: ctx.To ?? "webchat:local",
    senderId: ctx.SenderId ?? "operator",
    commandSource: "message",
    senderIsOwner: false,
    resetHookTriggered: false,
    ...overrides,
  });
}

function expectCalls(count: number, ...targets: MockInstance[]) {
  for (const target of targets) {
    expect.soft(target).toHaveBeenCalledTimes(count);
  }
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return buildGetReplyGroupCtx({
    ...bodyFields("<media:audio>"),
    GroupChannel: "ops",
    media: [
      { path: "/tmp/voice.ogg", url: "https://example.test/voice.ogg", contentType: "audio/ogg" },
    ],
    ...overrides,
  });
}

function reply(
  ctx: MsgContext,
  cfg: OpenClawConfig = {},
  opts?: Parameters<typeof getReplyFromConfig>[1],
) {
  return getReplyFromConfig(ctx, opts, withFastReplyConfig(cfg));
}

function buildTextCtx(body: string, overrides: Partial<MsgContext> = {}): MsgContext {
  return buildCtx({ ...bodyFields(body), BodyForCommands: body, media: undefined, ...overrides });
}

async function resetMocks() {
  vi.mocked(scope.resolveSessionAgentId).mockImplementation(actualScope.resolveSessionAgentId);
  delete process.env.OPENCLAW_TEST_FAST;
  for (const mock of [...Object.values(mocks), defaultModel, runReply, stageMedia, logVerbose]) {
    vi.mocked(mock).mockReset();
  }

  mocks.applyMediaUnderstanding.mockImplementation(async ({ ctx }) => {
    ctx.Transcript = "voice transcript";
    ctx.Body = "[Audio]\nTranscript:\nvoice transcript";
    ctx.BodyForAgent = "[Audio]\nTranscript:\nvoice transcript";
  });
  mocks.applyLinkUnderstanding.mockResolvedValue(undefined);
  mocks.createInternalHookEvent.mockImplementation(actualHooks.createInternalHookEvent);
  mocks.triggerInternalHook.mockResolvedValue(undefined);
  mocks.handleInlineActions.mockImplementation(async (...args: unknown[]) => {
    const params = args[0] as {
      directives?: unknown;
      cleanedBody?: string;
      abortedLastRun?: boolean;
    };
    return {
      kind: "continue",
      directives: params.directives ?? {},
      cleanedBody: params.cleanedBody ?? "",
      abortedLastRun: params.abortedLastRun,
    };
  });
  mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
  vi.mocked(defaultModel).mockReturnValue(defaultModelFacts());
  vi.mocked(runReply).mockResolvedValue({ text: "ok" });
  vi.mocked(stageMedia).mockResolvedValue({ staged: new Map() });
  mocks.resolveReplySessionPreprocessingState.mockReturnValue({
    sessionEntry: undefined,
    sessionKey: "agent:main:telegram:-100123",
    storePath: "/tmp/sessions.json",
  });
  mocks.initSessionState.mockResolvedValue(
    createGetReplySessionState({
      sessionKey: "agent:main:telegram:-100123",
      isGroup: true,
    }),
  );
}

async function runLocalPathSelfServeCase(params: {
  ctx: Partial<MsgContext>;
  cfg: OpenClawConfig;
  opts?: Parameters<typeof getReplyFromConfig>[1];
  provider?: string;
  model?: string;
  senderIsOwner?: boolean;
}) {
  const ctx = buildCtx(params.ctx);
  const enableLocalPathSelfServe = vi.fn();
  mocks.applyMediaUnderstanding.mockResolvedValueOnce({
    extractedFileImages: [],
    enableLocalPathSelfServe,
  });
  mocks.initSessionState.mockResolvedValueOnce(
    createGetReplySessionState({ sessionCtx: ctx, sessionKey: ctx.SessionKey, isGroup: false }),
  );
  mocks.resolveReplyDirectives.mockResolvedValueOnce(
    continueReply(ctx, {
      senderIsOwner: params.senderIsOwner ?? false,
      provider: params.provider,
      model: params.model,
    }),
  );

  await getReplyFromConfig(ctx, params.opts, withFastReplyConfig(params.cfg));
  return enableLocalPathSelfServe;
}

describe("getReplyFromConfig message hooks", () => {
  beforeEach(resetMocks);

  it.each([
    ["claude-cli", "audio/ogg", "audio-and-files"],
    ["codex", "text/plain", "files-only"],
  ])("preprocesses model-locked %s %s before dispatch", async (harness, mime, mode) => {
    const sessionKey = `agent:main:harness:${harness}:locked-media`;
    const preprocessingState = createLockedReplyPreprocessingState({
      sessionKey,
      sessionId: "locked-session",
      agentHarnessId: harness,
    });
    const preparedText =
      mime === "text/plain"
        ? "Pasted diagnostic: synthetic connection refused"
        : "voice transcript";
    mocks.resolveReplySessionPreprocessingState.mockReturnValueOnce(preprocessingState);
    mocks.applyMediaUnderstanding.mockImplementationOnce(async ({ ctx }) => {
      ctx.agentText = preparedText;
      ctx.BodyForAgent = preparedText;
    });
    await reply(
      buildCtx({
        SessionKey: sessionKey,
        media: [
          {
            path: mime === "text/plain" ? "/tmp/pasted-text-123.txt" : "/tmp/voice.ogg",
            contentType: mime,
          },
        ],
      }),
      mime === "audio/ogg" ? { tools: { media: { audio: { enabled: true } } } } : {},
    );
    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledWith(
      expect.objectContaining({ processingMode: mode }),
    );
    expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toMatchObject({
      ctx: { agentText: preparedText },
    });
  });

  const hostDocumentCtx = {
    SessionKey: "agent:main:main",
    OriginatingChannel: undefined,
    Provider: "webchat",
    Surface: "webchat",
    ChatType: "direct",
    SenderId: "operator",
  } as const;

  const sandboxDocumentCtx = {
    ...hostDocumentCtx,
    OriginatingChannel: "telegram",
    AccountId: "default",
    SenderId: "42",
  } as const;
  const sandboxDocumentConfig: OpenClawConfig = {
    agents: { defaults: { sandbox: { mode: "non-main", scope: "agent" } }, entries: { main: {} } },
  };

  it.each([true, false])(
    "enables sandboxed document self-service only after staging succeeds (%s)",
    async (staged) => {
      const stagedPaths = new Map(staged ? [[0, "media/inbound/report.docx"]] : []);
      vi.mocked(stageMedia).mockResolvedValueOnce({ staged: stagedPaths });
      const enable = await runLocalPathSelfServeCase({
        ctx: sandboxDocumentCtx,
        cfg: sandboxDocumentConfig,
      });
      expect(enable.mock.calls).toEqual(staged ? [[expect.any(Array), stagedPaths]] : []);
      expect(stageMedia).toHaveBeenCalledWith(expect.objectContaining({ agentId: "main" }));
    },
  );

  it("promotes a remote document staged before media understanding", async () => {
    const remotePath = "/remote/report.docx";
    const stagedPath = "media/inbound/report.docx";
    const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    vi.mocked(stageMedia).mockImplementationOnce(async (params) => {
      const stagedFacts = [{ path: stagedPath, contentType, workspaceDir: "/tmp/workspace" }];
      params.ctx.media = stagedFacts;
      params.sessionCtx.media = stagedFacts;
      return { staged: new Map([[0, stagedPath]]) };
    });
    const enable = await runLocalPathSelfServeCase({
      ctx: {
        ...sandboxDocumentCtx,
        media: [{ path: remotePath, contentType }],
        MediaRemoteHost: "user@gateway-host",
      },
      cfg: sandboxDocumentConfig,
    });

    expect(stageMedia).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(enable).toHaveBeenCalledWith(expect.any(Array), new Map([[0, stagedPath]]));
  });

  const providerPolicy = { tools: { byProvider: { anthropic: { deny: ["read"] } } } };
  const senderPolicy = { tools: { toolsBySender: { "*": { deny: ["read"] } } } };
  it.each<[string, Omit<Parameters<typeof runLocalPathSelfServeCase>[0], "ctx">, number]>([
    ["unavailable read tool", { cfg: {}, opts: { toolsAllow: ["message"] } }, 0],
    ["workspace-only file tools", { cfg: { tools: { fs: { workspaceOnly: true } } } }, 0],
    [
      "final provider denial",
      { cfg: providerPolicy, provider: "anthropic", model: "claude-sonnet" },
      0,
    ],
    ["unrelated provider policy", { cfg: providerPolicy, provider: "openai", model: "gpt-5" }, 1],
    ["wildcard sender denial", { cfg: senderPolicy }, 0],
    ["owner bypass of wildcard denial", { cfg: senderPolicy, senderIsOwner: true }, 1],
  ])("gates document self-service for %s", async (_name, options, calls) => {
    expect(
      await runLocalPathSelfServeCase({ ctx: hostDocumentCtx, ...options }),
    ).toHaveBeenCalledTimes(calls);
  });

  it("skips utility link understanding for a model-locked harness session", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:locked-link";
    const body = "read https://example.test/page";
    const preprocessingState = createLockedReplyPreprocessingState({
      sessionKey,
      sessionId: "locked-link-session",
      agentHarnessId: "codex",
    });
    const preprocessing = createDeferred<typeof preprocessingState>();
    const started = createDeferred();
    mocks.resolveReplySessionPreprocessingState.mockImplementationOnce(() => {
      started.resolve();
      return preprocessing.promise;
    });
    mocks.initSessionState.mockResolvedValueOnce(
      createGetReplySessionState({
        sessionCtx: { BodyForAgent: body, SessionKey: sessionKey },
        sessionEntry: preprocessingState.sessionEntry,
        sessionKey,
      }),
    );

    const pending = reply(buildTextCtx(body, { SessionKey: sessionKey }));
    await started.promise;
    expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    preprocessing.resolve(preprocessingState);
    await pending;

    expect(mocks.resolveReplySessionPreprocessingState).toHaveBeenCalledOnce();
    expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
    expect(mocks.initSessionState).toHaveBeenCalledOnce();
  });

  it("enriches staged text-only images before reply without switching the reply model", async () => {
    const enrichedBody = "describe image\n\n[Image 1]\na tiny dot image";
    const ctx = buildTextCtx("describe image", {
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      OriginatingTo: "webchat:local",
      ChatType: "direct",
      SessionKey: "agent:main:webchat:direct:user",
      From: "webchat:user",
      To: "webchat:local",
      media: [{ path: "/tmp/1.png", contentType: "image/png", workspaceDir: "/tmp" }],
    });
    const extractedPdfPage = {
      type: "image",
      data: "pdf-page",
      mimeType: "image/png",
      attachmentIndex: 0,
    } as const;
    vi.mocked(defaultModel).mockReturnValueOnce({
      defaultProvider: model.provider,
      defaultModel: model.model,
      aliasIndex: emptyAliasIndex(),
    });
    mocks.applyMediaUnderstanding.mockImplementationOnce(async (params) => {
      expect(params.agentId).toBe("main");
      expect(params.activeModel).toEqual(model);
      params.ctx.MediaUnderstanding = [
        {
          kind: "image.description",
          attachmentIndex: 0,
          provider: "openai",
          model: "gpt-4o",
          text: "a tiny dot image",
        },
      ];
      Object.assign(params.ctx, bodyFields(enrichedBody), { BodyForCommands: enrichedBody });
      return { extractedFileImages: [extractedPdfPage] };
    });
    mocks.resolveReplyDirectives.mockResolvedValueOnce(
      continueReply(ctx, {
        body: enrichedBody,
        senderId: "webchat:user",
        commandSource: "native",
        senderIsOwner: true,
        ...model,
      }),
    );

    await expect(
      reply(ctx, {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            imageModel: { primary: "openai/gpt-4o" },
          },
        },
      }),
    ).resolves.toEqual({ text: "ok" });

    expectCalls(
      1,
      mocks.applyMediaUnderstanding,
      mocks.resolveReplyDirectives,
      vi.mocked(runReply),
    );
    expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toMatchObject(model);
    const runParams = vi.mocked(runReply).mock.calls[0]?.[0];
    expect(runParams).toMatchObject({
      ...model,
      ctx: {
        BodyForAgent: expect.stringContaining("a tiny dot image"),
        MediaUnderstanding: [{ provider: "openai", model: "gpt-4o", text: "a tiny dot image" }],
      },
      opts: { extractedFileImages: [extractedPdfPage] },
    });
    expect(stageMedia).not.toHaveBeenCalled();
  });

  it("skips media understanding for a cached sticker", async () => {
    const stickerPath = "/tmp/cached-sticker.webp";
    await reply(
      buildTextCtx("[Sticker] Cached description", {
        media: [{ path: stickerPath, url: stickerPath, contentType: "image/webp" }],
        Sticker: { cachedDescription: "Cached description" },
        StickerMediaIncluded: true,
        SkipStickerMediaUnderstanding: true,
      }),
    );
    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
  });

  it("continues dispatching when media understanding fails before reply routing", async () => {
    mocks.applyMediaUnderstanding.mockRejectedValueOnce(
      new Error("Cannot find module '/tmp/openclaw/dist/media-understanding/apply.runtime-old.js'"),
    );

    expect(await reply(buildCtx())).toEqual({ text: "ok" });
    expectCalls(1, mocks.applyMediaUnderstanding, ...sessionAndDirectives);
    expect(mocks.createInternalHookEvent).toHaveBeenCalledExactlyOnceWith(
      "message",
      "preprocessed",
      "agent:main:telegram:-100123",
      expect.any(Object),
    );
  });

  it.each([
    { phase: "link", resolves: false },
    { phase: "link", resolves: true },
    { phase: "binding", resolves: true },
  ])(
    "stops canceled replies during $phase work (resolves: $resolves)",
    async ({ phase, resolves }) => {
      const controller = new AbortController();
      const reason = resolves ? new Error("reply canceled") : undefined;
      if (phase === "binding") {
        mocks.resolveReplySessionPreprocessingState.mockImplementationOnce(async () => {
          controller.abort(reason);
          return { sessionKey: "agent:main:telegram:-100123", storePath: "/tmp/sessions.json" };
        });
      }
      mocks.applyLinkUnderstanding.mockImplementationOnce(async (...args: unknown[]) => {
        const { signal } = args[0] as { signal?: AbortSignal };
        controller.abort(reason);
        if (!resolves) {
          signal?.throwIfAborted();
        }
      });

      await expect
        .soft(
          reply(
            buildTextCtx("read https://example.test/page"),
            {},
            { abortSignal: controller.signal },
          ),
        )
        .rejects.toMatchObject({ name: "AbortError", ...(reason ? { cause: reason } : {}) });

      expect(mocks.applyLinkUnderstanding).toHaveBeenCalledTimes(phase === "binding" ? 0 : 1);
      expectCalls(0, ...sessionAndDirectives, ...hooks);
    },
  );

  it("stops a canceled status reply while thinking catalog discovery is pending", async () => {
    const catalog = createDeferred<[]>();
    const entered = createDeferred();
    const controller = new AbortController();
    const directives = continueReply(buildTextCtx("/status"), {
      body: "/status",
      abortKey: "agent:main:telegram:-100123",
      from: "telegram:user:42",
      to: "telegram:-100123",
      senderId: "42",
      senderIsOwner: true,
    });
    directives.result.inlineStatusRequested = true;
    directives.result.modelState.resolveThinkingCatalog = async () => {
      entered.resolve();
      return catalog.promise;
    };
    mocks.resolveReplyDirectives.mockResolvedValueOnce(directives);

    const pending = reply(buildTextCtx("/status"), {}, { abortSignal: controller.signal });
    await entered.promise;
    const outcome = pending.then(
      () => "completed",
      (error: unknown) => (error instanceof Error ? error.name : "unknown"),
    );
    controller.abort();
    try {
      expect(
        await Promise.race([
          outcome,
          new Promise<string>((resolve) => {
            setImmediate(() => resolve("pending"));
          }),
        ]),
      ).toBe("AbortError");
      expect(mocks.handleInlineActions).not.toHaveBeenCalled();
    } finally {
      catalog.resolve([]);
      await Promise.allSettled([pending]);
    }
  });

  it("keeps literal URL input after link failure", async () => {
    const ctx = buildTextCtx("read https://example.test/page", {
      CommandInterpretationSuppressed: true,
    });
    mocks.applyLinkUnderstanding.mockRejectedValueOnce(
      new Error("Cannot find module '/tmp/openclaw/dist/link-understanding/apply.runtime-old.js'"),
    );

    expect(await reply(ctx)).toEqual({ text: "ok" });
    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
    expectCalls(1, mocks.applyLinkUnderstanding, ...sessionAndDirectives);
  });
});

describe("getReplyFromConfig media staging", () => {
  beforeAll(async () => {
    vi.mocked(scope.resolveSessionAgentId).mockImplementation(() => "main");
    const globals = await vi.importActual<typeof import("../../globals.js")>("../../globals.js");
    vi.mocked(logVerbose).mockImplementation(globals.logVerbose);
    vi.mocked(defaultModel).mockReturnValue(defaultModelFacts());
  });

  function prepareMediaReply(
    ctx: MsgContext,
    state: OpenClawTestState,
    sessionEntry?: SessionEntry,
  ) {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    vi.mocked(stageMedia).mockReset().mockResolvedValue({ staged: new Map() });
    mocks.applyMediaUnderstanding.mockResolvedValue({ extractedFileImages: [] });
    vi.mocked(runReply).mockReset().mockResolvedValue({ text: "ready" });
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: ctx,
        storePath: state.path("sessions.json"),
        sessionEntryHandle: createReplySessionEntryHandle(
          sessionEntry ? { sessionEntry, sessionKey: ctx.SessionKey } : {},
        ),
        ...(sessionEntry
          ? { sessionEntry, sessionKey: ctx.SessionKey, sessionId: sessionEntry.sessionId }
          : {}),
      }),
    );
    mocks.resolveReplySessionPreprocessingState.mockReturnValue({
      sessionEntry: undefined,
      sessionKey: ctx.SessionKey,
      storePath: state.path("sessions.json"),
    });
    mocks.resolveReplyDirectives.mockResolvedValue(
      continueReply(ctx, {
        body: "inspect this attachment",
        senderId: sessionEntry ? "owner" : "42",
        senderIsOwner: Boolean(sessionEntry),
      }),
    );
    mocks.handleInlineActions.mockResolvedValue({
      kind: "continue",
      directives: {},
      cleanedBody: "inspect this attachment",
    });
  }

  it.each(["remote preprocessing", "local staging"] as const)(
    "cancels %s before downstream work and waits for staging cleanup",
    async (phase) => {
      await withOpenClawTestState(
        { label: "reply-media-staging", env: { OPENCLAW_TEST_FAST: undefined } },
        async (state) => {
          const controller = new AbortController();
          const reason = new Error("attachment request cancelled");
          const cleanup = createDeferred();
          let cleanupStarted = false;
          let cleanupFinished = false;
          const ctx = buildGetReplyGroupCtx({
            media: [{ path: "/remote/photo.jpg", contentType: "image/jpeg" }],
            MediaRemoteHost: phase === "remote preprocessing" ? "user@gateway-host" : undefined,
          });
          prepareMediaReply(ctx, state);
          vi.mocked(stageMedia).mockImplementationOnce(
            async (params: Parameters<typeof stageMedia>[0] & { abortSignal?: AbortSignal }) => {
              try {
                await waitForAbortSignal(params.abortSignal);
                params.abortSignal?.throwIfAborted();
                return { staged: new Map<number, string>() };
              } finally {
                cleanupStarted = true;
                await cleanup.promise;
                cleanupFinished = true;
              }
            },
          );
          const pending = reply(
            ctx,
            { agents: { defaults: { workspace: state.workspaceDir } } },
            { abortSignal: controller.signal },
          );
          const replySettlement = vi.fn();
          const joined = pending.then(replySettlement, replySettlement);
          try {
            await vi.waitFor(() => expect(stageMedia).toHaveBeenCalledOnce());
            const preprocessingCalls = phase === "remote preprocessing" ? 0 : 1;
            expectCalls(
              preprocessingCalls,
              mocks.applyMediaUnderstanding,
              mocks.triggerInternalHook,
            );
            controller.abort(reason);
            await vi.waitFor(() => expect(cleanupStarted).toBe(true));
            expect(cleanupFinished).toBe(false);
            expect(replySettlement).not.toHaveBeenCalled();
            expect(runReply).not.toHaveBeenCalled();

            cleanup.resolve();
            await expect.soft(pending).rejects.toBe(reason);
            expect(cleanupFinished).toBe(true);
            expectCalls(preprocessingCalls, mocks.applyMediaUnderstanding, ...hooks);
            expect.soft(runReply).not.toHaveBeenCalled();
            if (phase === "remote preprocessing") {
              expectCalls(0, ...sessionAndDirectives, mocks.handleInlineActions);
            }
          } finally {
            controller.abort(reason);
            cleanup.resolve();
            await joined;
          }
        },
      );
    },
  );

  it("stages inbound media in the ordinary session cwd", async () => {
    await withOpenClawTestState(
      { label: "reply-media-workspace", env: { OPENCLAW_TEST_FAST: undefined } },
      async (state) => {
        const configuredWorkspace = state.path("configured-workspace");
        const sessionCwd = state.path("session-workspace");
        const sessionKey = "agent:main:upload-workspace";
        await Promise.all(
          [configuredWorkspace, sessionCwd].map((directory) =>
            fs.mkdir(directory, { recursive: true }),
          ),
        );
        const sessionEntry: SessionEntry = {
          sessionId: "session-media-workspace",
          updatedAt: 1,
          spawnedCwd: sessionCwd,
        };
        const ctx = buildGetReplyCtx({
          Provider: "webchat",
          Surface: "webchat",
          SessionKey: sessionKey,
          From: "webchat:owner",
          To: "webchat:workspace",
          media: [{ path: state.path("media/inbound/photo.png"), contentType: "image/png" }],
        });
        prepareMediaReply(ctx, state, sessionEntry);

        await reply(ctx, { agents: { defaults: { workspace: configuredWorkspace } } });

        expect(stageMedia).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ workspaceDir: sessionCwd }),
        );
        expect(runReply).toHaveBeenCalledOnce();
      },
    );
  });
});
