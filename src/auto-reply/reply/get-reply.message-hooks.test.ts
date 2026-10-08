// Tests get-reply message hooks before and after agent execution.
import fs from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let defaultModel: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let runReply: typeof import("./get-reply-run.js").runPreparedReply;
let stageMedia: typeof import("./stage-sandbox-media.js").stageSandboxMedia;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ resolveDefaultModel: defaultModel } = await import("./directive-handling.defaults.js"));
  ({ runPreparedReply: runReply } = await import("./get-reply-run.js"));
  ({ stageSandboxMedia: stageMedia } = await import("./stage-sandbox-media.js"));
  const scope = await import("../../agents/agent-scope.js");
  const actualScope = await vi.importActual<typeof scope>("../../agents/agent-scope.js");
  vi.mocked(scope.resolveSessionAgentId).mockImplementation(actualScope.resolveSessionAgentId);
}

function emptyAliasIndex() {
  return { byAlias: new Map(), byKey: new Map() };
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return buildGetReplyGroupCtx({
    Body: "<media:audio>",
    BodyForAgent: "<media:audio>",
    RawBody: "<media:audio>",
    CommandBody: "<media:audio>",
    GroupChannel: "ops",
    media: [
      {
        path: "/tmp/voice.ogg",
        url: "https://example.test/voice.ogg",
        contentType: "audio/ogg",
      },
    ],
    ...overrides,
  });
}

function buildConfiguredAudioCfg() {
  return withFastReplyConfig({ tools: { media: { audio: { enabled: true } } } });
}

function buildTextCtx(body: string, overrides: Partial<MsgContext> = {}): MsgContext {
  return buildCtx({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    BodyForCommands: body,
    media: undefined,
    ...overrides,
  });
}

async function resetMocks() {
  await loadGetReplyRuntimeForTest();
  delete process.env.OPENCLAW_TEST_FAST;
  Object.values(mocks).forEach((mock) => mock.mockReset());
  vi.mocked(defaultModel).mockReset();
  vi.mocked(runReply).mockReset();
  vi.mocked(stageMedia).mockReset();
  vi.mocked(logVerbose).mockReset();

  mocks.applyMediaUnderstanding.mockImplementation(async ({ ctx }) => {
    ctx.Transcript = "voice transcript";
    ctx.Body = "[Audio]\nTranscript:\nvoice transcript";
    ctx.BodyForAgent = "[Audio]\nTranscript:\nvoice transcript";
  });
  mocks.applyLinkUnderstanding.mockResolvedValue(undefined);
  mocks.createInternalHookEvent.mockImplementation(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      type,
      action,
      sessionKey,
      context,
      timestamp: new Date(),
      messages: [],
    }),
  );
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
  vi.mocked(defaultModel).mockReturnValue({
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: emptyAliasIndex(),
  });
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
      sessionScope: "per-chat",
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
    createGetReplySessionState({
      sessionCtx: ctx,
      sessionKey: ctx.SessionKey,
      isGroup: false,
    }),
  );
  mocks.resolveReplyDirectives.mockResolvedValueOnce(
    createGetReplyContinueDirectivesResult({
      body: ctx.BodyForAgent ?? "read the document",
      abortKey: ctx.SessionKey ?? "agent:main:main",
      from: ctx.From ?? "webchat:operator",
      to: ctx.To ?? "webchat:local",
      senderId: ctx.SenderId ?? "operator",
      commandSource: "message",
      senderIsOwner: params.senderIsOwner ?? false,
      resetHookTriggered: false,
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
    {
      label: "configured audio",
      harness: "claude-cli",
      mime: "audio/ogg",
      configuredAudio: true,
      mode: "audio-and-files",
    },
    {
      label: "pasted text",
      harness: "codex",
      mime: "text/plain",
      configuredAudio: false,
      mode: "files-only",
    },
  ])(
    "preprocesses model-locked $label before dispatch",
    async ({ harness, mime, configuredAudio, mode }) => {
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
      await getReplyFromConfig(
        buildCtx({
          SessionKey: sessionKey,
          media: [
            {
              path: mime === "text/plain" ? "/tmp/pasted-text-123.txt" : "/tmp/voice.ogg",
              contentType: mime,
            },
          ],
        }),
        undefined,
        configuredAudio ? buildConfiguredAudioCfg() : withFastReplyConfig({}),
      );
      expect(mocks.applyMediaUnderstanding).toHaveBeenCalledWith(
        expect.objectContaining({ processingMode: mode }),
      );
      expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toMatchObject({
        ctx: { agentText: preparedText },
      });
    },
  );

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
    agents: {
      defaults: { sandbox: { mode: "non-main", scope: "agent" } },
      entries: { main: {} },
    },
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
      const stagedFacts = [
        {
          path: stagedPath,
          contentType,
          workspaceDir: "/tmp/workspace",
        },
      ];
      params.ctx.media = stagedFacts;
      params.sessionCtx.media = stagedFacts;
      return { staged: new Map([[0, stagedPath]]) };
    });
    const enable = await runLocalPathSelfServeCase({
      ctx: {
        ...sandboxDocumentCtx,
        media: [
          {
            path: remotePath,
            contentType,
          },
        ],
        MediaRemoteHost: "user@gateway-host",
      },
      cfg: sandboxDocumentConfig,
    });

    expect(stageMedia).toHaveBeenCalledOnce();
    expect(stageMedia).toHaveBeenCalledWith(expect.objectContaining({ agentId: "main" }));
    expect(enable).toHaveBeenCalledWith(expect.any(Array), new Map([[0, stagedPath]]));
  });

  it("withholds local document self-service when the turn cannot read files", async () => {
    const enable = await runLocalPathSelfServeCase({
      ctx: hostDocumentCtx,
      cfg: {},
      opts: { toolsAllow: ["message"] },
    });
    expect(enable).not.toHaveBeenCalled();
  });

  it("withholds local document self-service from workspace-only file tools", async () => {
    const enable = await runLocalPathSelfServeCase({
      ctx: hostDocumentCtx,
      cfg: { tools: { fs: { workspaceOnly: true } } },
    });
    expect(enable).not.toHaveBeenCalled();
  });

  it("projects local document self-service against the final provider", async () => {
    const cfg = { tools: { byProvider: { anthropic: { deny: ["read"] } } } };
    const denied = await runLocalPathSelfServeCase({
      ctx: hostDocumentCtx,
      cfg,
      provider: "anthropic",
      model: "claude-sonnet",
    });
    expect(denied).not.toHaveBeenCalled();

    await resetMocks();
    const unrelated = await runLocalPathSelfServeCase({
      ctx: hostDocumentCtx,
      cfg,
      provider: "openai",
      model: "gpt-5",
    });
    expect(unrelated).toHaveBeenCalledOnce();
  });

  it("applies wildcard sender policy only to non-owner turns", async () => {
    const cfg = { tools: { toolsBySender: { "*": { deny: ["read"] } } } };
    const nonOwner = await runLocalPathSelfServeCase({ ctx: hostDocumentCtx, cfg });
    expect(nonOwner).not.toHaveBeenCalled();

    await resetMocks();
    const owner = await runLocalPathSelfServeCase({
      ctx: hostDocumentCtx,
      cfg,
      senderIsOwner: true,
    });
    expect(owner).toHaveBeenCalledOnce();
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

    const reply = getReplyFromConfig(
      buildTextCtx(body, { SessionKey: sessionKey }),
      undefined,
      withFastReplyConfig({}),
    );
    await started.promise;
    expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    preprocessing.resolve(preprocessingState);
    await reply;

    expect(mocks.resolveReplySessionPreprocessingState).toHaveBeenCalledOnce();
    expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
    expect(mocks.initSessionState).toHaveBeenCalledOnce();
  });

  it("enriches staged text-only images before reply without switching the reply model", async () => {
    const enrichedBody = "describe image\n\n[Image 1]\na tiny dot image";
    const extractedPdfPage = {
      type: "image",
      data: "pdf-page",
      mimeType: "image/png",
      attachmentIndex: 0,
    } as const;
    vi.mocked(defaultModel).mockReturnValueOnce({
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: emptyAliasIndex(),
    });
    mocks.applyMediaUnderstanding.mockImplementationOnce(async (params) => {
      expect(params.activeModel).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(params.agentId).toBe("main");
      params.ctx.MediaUnderstanding = [
        {
          kind: "image.description",
          attachmentIndex: 0,
          provider: "openai",
          model: "gpt-4o",
          text: "a tiny dot image",
        },
      ];
      params.ctx.Body = enrichedBody;
      params.ctx.BodyForAgent = enrichedBody;
      params.ctx.BodyForCommands = enrichedBody;
      params.ctx.CommandBody = enrichedBody;
      params.ctx.RawBody = enrichedBody;
      return {
        extractedFileImages: [extractedPdfPage],
      };
    });
    mocks.resolveReplyDirectives.mockResolvedValueOnce(
      createGetReplyContinueDirectivesResult({
        body: enrichedBody,
        abortKey: "agent:main:webchat:direct:user",
        from: "webchat:user",
        to: "webchat:local",
        senderId: "webchat:user",
        commandSource: "native",
        senderIsOwner: true,
        resetHookTriggered: false,
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );

    await expect(
      getReplyFromConfig(
        buildTextCtx("describe image", {
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "webchat:local",
          ChatType: "direct",
          SessionKey: "agent:main:webchat:direct:user",
          From: "webchat:user",
          To: "webchat:local",
          media: [{ path: "/tmp/1.png", contentType: "image/png", workspaceDir: "/tmp" }],
        }),
        undefined,
        withFastReplyConfig({
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-6",
              imageModel: { primary: "openai/gpt-4o" },
            },
          },
        }),
      ),
    ).resolves.toEqual({ text: "ok" });

    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(vi.mocked(runReply)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runReply).mock.calls[0]?.[0];
    expect(runParams).toMatchObject({ provider: "anthropic", model: "claude-opus-4-6" });
    expect(runParams?.ctx.BodyForAgent).toContain("a tiny dot image");
    expect(runParams?.ctx.MediaUnderstanding).toEqual([
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o",
        text: "a tiny dot image",
      }),
    ]);
    expect(runParams?.opts).toMatchObject({ extractedFileImages: [extractedPdfPage] });
    expect(stageMedia).not.toHaveBeenCalled();
  });

  it("skips media understanding for a cached sticker", async () => {
    const stickerPath = "/tmp/cached-sticker.webp";
    await getReplyFromConfig(
      buildTextCtx("[Sticker] Cached description", {
        media: [{ path: stickerPath, url: stickerPath, contentType: "image/webp" }],
        Sticker: { cachedDescription: "Cached description" },
        StickerMediaIncluded: true,
        SkipStickerMediaUnderstanding: true,
      }),
      undefined,
      withFastReplyConfig({}),
    );
    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
  });

  it("continues dispatching when media understanding fails before reply routing", async () => {
    mocks.applyMediaUnderstanding.mockRejectedValueOnce(
      new Error("Cannot find module '/tmp/openclaw/dist/media-understanding/apply.runtime-old.js'"),
    );

    const reply = await getReplyFromConfig(buildCtx(), undefined, withFastReplyConfig({}));

    expect(reply).toEqual({ text: "ok" });
    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledTimes(1);
    expect(mocks.initSessionState).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledTimes(1);
    expect(mocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    expect(mocks.createInternalHookEvent).toHaveBeenCalledWith(
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
          getReplyFromConfig(
            buildTextCtx("read https://example.test/page"),
            {
              abortSignal: controller.signal,
            },
            withFastReplyConfig({}),
          ),
        )
        .rejects.toMatchObject({ name: "AbortError", ...(reason ? { cause: reason } : {}) });

      expect(mocks.applyLinkUnderstanding).toHaveBeenCalledTimes(phase === "binding" ? 0 : 1);
      expect.soft(mocks.initSessionState).not.toHaveBeenCalled();
      expect.soft(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
      expect.soft(mocks.createInternalHookEvent).not.toHaveBeenCalled();
      expect.soft(mocks.triggerInternalHook).not.toHaveBeenCalled();
    },
  );

  it("keeps literal URL input after link failure", async () => {
    const ctx = buildTextCtx("read https://example.test/page", {
      CommandInterpretationSuppressed: true,
    });
    mocks.applyLinkUnderstanding.mockRejectedValueOnce(
      new Error("Cannot find module '/tmp/openclaw/dist/link-understanding/apply.runtime-old.js'"),
    );

    const reply = await getReplyFromConfig(ctx, undefined, withFastReplyConfig({}));

    expect(reply).toEqual({ text: "ok" });
    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
    expect(mocks.applyLinkUnderstanding).toHaveBeenCalledTimes(1);
    expect(mocks.initSessionState).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledTimes(1);
  });
});

describe("getReplyFromConfig media staging", () => {
  beforeAll(async () => {
    await loadGetReplyRuntimeForTest();
    const scope = await import("../../agents/agent-scope.js");
    vi.mocked(scope.resolveSessionAgentId).mockImplementation(() => "main");
    const globals = await vi.importActual<typeof import("../../globals.js")>("../../globals.js");
    vi.mocked(logVerbose).mockImplementation(globals.logVerbose);
    vi.mocked(defaultModel).mockReturnValue({
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: emptyAliasIndex(),
    });
  });

  function prepareMediaReply(
    ctx: MsgContext,
    state: OpenClawTestState,
    sessionEntry?: SessionEntry,
  ) {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    vi.mocked(stageMedia).mockReset().mockResolvedValue({ staged: new Map() });
    vi.mocked(mocks.applyMediaUnderstanding)
      .mockReset()
      .mockResolvedValue({ extractedFileImages: [] });
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
      createGetReplyContinueDirectivesResult({
        body: "inspect this attachment",
        abortKey: ctx.SessionKey ?? "agent:main:telegram:-100123",
        from: ctx.From ?? "telegram:user:42",
        to: ctx.To ?? "telegram:-100123",
        senderId: sessionEntry ? "owner" : "42",
        commandSource: "message",
        senderIsOwner: Boolean(sessionEntry),
        resetHookTriggered: false,
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
          const reply = getReplyFromConfig(
            ctx,
            { abortSignal: controller.signal },
            withFastReplyConfig({ agents: { defaults: { workspace: state.workspaceDir } } }),
          );
          const replySettlement = vi.fn();
          const joined = reply.then(replySettlement, replySettlement);
          try {
            await vi.waitFor(() => expect(stageMedia).toHaveBeenCalledOnce());
            const preprocessingCalls = phase === "remote preprocessing" ? 0 : 1;
            expect(mocks.applyMediaUnderstanding).toHaveBeenCalledTimes(preprocessingCalls);
            expect(mocks.triggerInternalHook).toHaveBeenCalledTimes(preprocessingCalls);
            controller.abort(reason);
            await vi.waitFor(() => expect(cleanupStarted).toBe(true));
            expect(cleanupFinished).toBe(false);
            expect(replySettlement).not.toHaveBeenCalled();
            expect(runReply).not.toHaveBeenCalled();

            cleanup.resolve();
            await expect.soft(reply).rejects.toBe(reason);
            expect(cleanupFinished).toBe(true);
            expect.soft(mocks.applyMediaUnderstanding).toHaveBeenCalledTimes(preprocessingCalls);
            expect.soft(mocks.triggerInternalHook).toHaveBeenCalledTimes(preprocessingCalls);
            expect.soft(mocks.createInternalHookEvent).toHaveBeenCalledTimes(preprocessingCalls);
            expect.soft(runReply).not.toHaveBeenCalled();
            if (phase === "remote preprocessing") {
              expect.soft(mocks.initSessionState).not.toHaveBeenCalled();
              expect.soft(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
              expect.soft(mocks.handleInlineActions).not.toHaveBeenCalled();
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

  it.each([
    { name: "ordinary session cwd", kind: "session", destination: "session-workspace" },
    { name: "inherited subagent workspace", kind: "spawned", destination: "inherited-workspace" },
  ] as const)("stages inbound media in the $name", async ({ kind, destination }) => {
    await withOpenClawTestState(
      { label: "reply-media-workspace", env: { OPENCLAW_TEST_FAST: undefined } },
      async (state) => {
        const configuredWorkspace = state.path("configured-workspace");
        const sessionCwd = state.path("session-workspace");
        const inheritedWorkspace = state.path("inherited-workspace");
        const sessionKey =
          kind === "spawned"
            ? "agent:main:subagent:upload-workspace"
            : "agent:main:upload-workspace";
        await Promise.all(
          [configuredWorkspace, sessionCwd, inheritedWorkspace].map((directory) =>
            fs.mkdir(directory, { recursive: true }),
          ),
        );
        const sessionEntry: SessionEntry = {
          sessionId: "session-media-workspace",
          updatedAt: 1,
          spawnedCwd: sessionCwd,
          ...(kind === "spawned"
            ? {
                spawnedBy: "agent:main:main",
                spawnedWorkspaceDir: inheritedWorkspace,
              }
            : {}),
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

        await getReplyFromConfig(
          ctx,
          undefined,
          withFastReplyConfig({ agents: { defaults: { workspace: configuredWorkspace } } }),
        );

        expect(stageMedia).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ workspaceDir: state.path(destination) }),
        );
        expect(runReply).toHaveBeenCalledOnce();
      },
    );
  });
});
