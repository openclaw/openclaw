import fs from "node:fs/promises";
import { beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { waitForAbortSignal } from "../../infra/abort-signal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyCtx,
  buildGetReplyGroupCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyBaselineBypass,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  initSessionState: vi.fn(),
  resolveReplySessionPreprocessingState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));

registerGetReplyBaselineBypass();
registerGetReplyRuntimeOverrides(mocks);
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: mocks.createInternalHookEvent,
  triggerInternalHook: mocks.triggerInternalHook,
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let stageSandboxMedia: typeof import("./stage-sandbox-media.runtime.js").stageSandboxMedia;
let applyMediaUnderstanding: typeof import("../../media-understanding/apply.runtime.js").applyMediaUnderstanding;
let runPreparedReply: typeof import("./get-reply-run.js").runPreparedReply;

beforeAll(async () => {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ stageSandboxMedia } = await import("./stage-sandbox-media.runtime.js"));
  ({ applyMediaUnderstanding } = await import("../../media-understanding/apply.runtime.js"));
  ({ runPreparedReply } = await import("./get-reply-run.js"));
  const { resolveDefaultModel } = await import("./directive-handling.defaults.js");
  vi.mocked(resolveDefaultModel).mockReturnValue({
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
  });
});

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
        vi.mocked(stageSandboxMedia)
          .mockReset()
          .mockImplementationOnce(
            async (
              params: Parameters<typeof stageSandboxMedia>[0] & { abortSignal?: AbortSignal },
            ) => {
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
        vi.mocked(applyMediaUnderstanding).mockReset().mockResolvedValue({
          outputs: [],
          decisions: [],
          extractedFileImages: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: false,
        });
        vi.mocked(runPreparedReply).mockReset().mockResolvedValue({ text: "must not reply" });
        mocks.createInternalHookEvent.mockClear();
        mocks.triggerInternalHook.mockClear();
        const ctx = buildGetReplyGroupCtx({
          media: [{ path: "/remote/photo.jpg", contentType: "image/jpeg" }],
          MediaRemoteHost: phase === "remote preprocessing" ? "user@gateway-host" : undefined,
        });
        mocks.initSessionState.mockReset().mockResolvedValue(
          createGetReplySessionState({
            sessionCtx: ctx,
            storePath: state.path("sessions.json"),
            sessionEntryHandle: createReplySessionEntryHandle({}),
          }),
        );
        mocks.resolveReplySessionPreprocessingState.mockReset().mockReturnValue({
          sessionEntry: undefined,
          sessionKey: ctx.SessionKey,
          storePath: state.path("sessions.json"),
        });
        mocks.resolveReplyDirectives.mockReset().mockResolvedValue(
          createGetReplyContinueDirectivesResult({
            body: "inspect this attachment",
            abortKey: "agent:main:telegram:-100123",
            from: "telegram:user:42",
            to: "telegram:-100123",
            senderId: "42",
            commandSource: "message",
            senderIsOwner: false,
            resetHookTriggered: false,
          }),
        );
        mocks.handleInlineActions.mockReset().mockResolvedValue({
          kind: "continue",
          directives: {},
          cleanedBody: "inspect this attachment",
        });
        const reply = getReplyFromConfig(
          ctx,
          { abortSignal: controller.signal },
          withFastReplyConfig({ agents: { defaults: { workspace: state.workspaceDir } } }),
        );
        const replySettlement = vi.fn();
        const joined = reply.then(replySettlement, replySettlement);
        try {
          await vi.waitFor(() => expect(stageSandboxMedia).toHaveBeenCalledOnce());
          const preprocessingCalls = phase === "remote preprocessing" ? 0 : 1;
          expect(applyMediaUnderstanding).toHaveBeenCalledTimes(preprocessingCalls);
          expect(mocks.triggerInternalHook).toHaveBeenCalledTimes(preprocessingCalls);
          controller.abort(reason);
          await vi.waitFor(() => expect(cleanupStarted).toBe(true));
          expect(cleanupFinished).toBe(false);
          expect(replySettlement).not.toHaveBeenCalled();
          expect(runPreparedReply).not.toHaveBeenCalled();

          cleanup.resolve();
          await expect.soft(reply).rejects.toBe(reason);
          expect(cleanupFinished).toBe(true);
          expect.soft(applyMediaUnderstanding).toHaveBeenCalledTimes(preprocessingCalls);
          expect.soft(mocks.triggerInternalHook).toHaveBeenCalledTimes(preprocessingCalls);
          expect.soft(mocks.createInternalHookEvent).toHaveBeenCalledTimes(preprocessingCalls);
          expect.soft(runPreparedReply).not.toHaveBeenCalled();
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
  { name: "configured workspace", kind: "default", destination: "configured-workspace" },
  { name: "inherited subagent workspace", kind: "spawned", destination: "inherited-workspace" },
] as const)("stages inbound media in the $name", async ({ kind, destination }) => {
  await withOpenClawTestState(
    { label: "reply-media-workspace", env: { OPENCLAW_TEST_FAST: undefined } },
    async (state) => {
      const configuredWorkspace = state.path("configured-workspace");
      const sessionCwd = state.path("session-workspace");
      const inheritedWorkspace = state.path("inherited-workspace");
      const sessionKey =
        kind === "spawned" ? "agent:main:subagent:upload-workspace" : "agent:main:upload-workspace";
      await Promise.all(
        [configuredWorkspace, sessionCwd, inheritedWorkspace].map((directory) =>
          fs.mkdir(directory, { recursive: true }),
        ),
      );
      const sessionEntry: SessionEntry = {
        sessionId: "session-media-workspace",
        updatedAt: 1,
        ...(kind !== "default" ? { spawnedCwd: sessionCwd } : {}),
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
      vi.mocked(stageSandboxMedia).mockReset().mockResolvedValue({ staged: new Map() });
      vi.mocked(applyMediaUnderstanding).mockReset().mockResolvedValue({
        outputs: [],
        decisions: [],
        extractedFileImages: [],
        appliedImage: false,
        appliedAudio: false,
        appliedVideo: false,
        appliedFile: false,
      });
      vi.mocked(runPreparedReply).mockReset().mockResolvedValue({ text: "ready" });
      mocks.createInternalHookEvent.mockClear();
      mocks.triggerInternalHook.mockClear();
      mocks.initSessionState.mockReset().mockResolvedValue(
        createGetReplySessionState({
          sessionCtx: ctx,
          sessionEntry,
          sessionEntryHandle: createReplySessionEntryHandle({ sessionEntry, sessionKey }),
          sessionKey,
          sessionId: sessionEntry.sessionId,
          storePath: state.path("sessions.json"),
        }),
      );
      mocks.resolveReplySessionPreprocessingState.mockReset().mockReturnValue({
        sessionEntry: undefined,
        sessionKey,
        storePath: state.path("sessions.json"),
      });
      mocks.resolveReplyDirectives.mockReset().mockResolvedValue(
        createGetReplyContinueDirectivesResult({
          body: "inspect this attachment",
          abortKey: sessionKey,
          from: "webchat:owner",
          to: "webchat:workspace",
          senderId: "owner",
          commandSource: "message",
          senderIsOwner: true,
          resetHookTriggered: false,
        }),
      );
      mocks.handleInlineActions.mockReset().mockResolvedValue({
        kind: "continue",
        directives: {},
        cleanedBody: "inspect this attachment",
      });

      await getReplyFromConfig(
        ctx,
        undefined,
        withFastReplyConfig({ agents: { defaults: { workspace: configuredWorkspace } } }),
      );

      expect(stageSandboxMedia).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ workspaceDir: state.path(destination) }),
      );
      expect(runPreparedReply).toHaveBeenCalledOnce();
    },
  );
});
