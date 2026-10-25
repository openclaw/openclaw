import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { detectAndLoadPromptImages } from "../../agents/embedded-agent-runner/run/images.js";
import { FailoverError } from "../../agents/failover-error.js";
import { registerGeneratedMediaTaskActivity } from "../../agents/media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../../agents/media-generation-activity.test-support.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { TemplateContext } from "../templating.js";
import {
  createCliFollowupRun as createCliRun,
  createMinimalRunAgentTurnParams,
  expectMockCallArgFields,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import { createTestUserTurnRecorder } from "./agent-runner-execution.transcript.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();

function cliResult<Meta>(text: string, meta: Meta) {
  return { payloads: [{ text }], meta };
}

function legacyCliSession(sessionId: string): SessionEntry {
  return {
    sessionId: "openclaw-session",
    updatedAt: 1,
    cliSessionBindings: { "claude-cli": { sessionId } },
    cliSessionIds: { "claude-cli": sessionId },
    claudeCliSessionId: sessionId,
  };
}

function sessionParams(
  followupRun: ReturnType<typeof createCliRun>,
  sessionEntry: SessionEntry,
  sessionKey = "main",
) {
  return {
    ...createMinimalRunAgentTurnParams({ followupRun }),
    sessionKey,
    activeSessionStore: { [sessionKey]: sessionEntry },
    getActiveSessionEntry: () => sessionEntry,
  };
}

afterEach(resetGeneratedMediaTaskActivityForTests);

function rejectUnexpectedCompactionSuccessor(): never {
  throw new Error("Unexpected compaction successor during CLI session routing test");
}

describe("executeAgentTurn: CLI session routing", () => {
  it.each([{ provider: "webchat", messageId: "rpc-run-id", currentMessageId: undefined }])(
    "carries prepared route facts without leaking $provider identity into replies",
    async ({ provider, messageId, currentMessageId }) => {
      const { isInternalMessageChannel } = await vi.importActual<
        typeof import("../../utils/message-channel.js")
      >("../../utils/message-channel.js");
      state.isInternalMessageChannelMock.mockImplementation((channel) =>
        isInternalMessageChannel(typeof channel === "string" ? channel : undefined),
      );
      const followupRun = createCliRun("claude-cli", "claude-sonnet-4-6");
      state.runCliAgentMock.mockResolvedValueOnce(cliResult("done", {}));
      followupRun.originatingThreadId = 42;
      followupRun.run.conversationToolPolicy = {
        allow: ["read", "sessions_spawn"],
        deny: ["exec"],
      };
      followupRun.run.execOverrides = { host: "node", node: "mac-a" };
      followupRun.run.bashElevated = { enabled: true, allowed: true, defaultLevel: "full" };
      followupRun.run.runtimePolicySessionKey = "agent:main:telegram:default:direct:sender-static";
      followupRun.run.thinkingCatalog = [
        {
          provider: "claude-cli",
          id: "claude-sonnet-4-6",
          contextWindow: 400_000,
          contextTokens: 321_000,
          input: ["text", "image"],
        },
      ];

      const result = await executeAgentTurn(
        createMinimalRunAgentTurnParams({
          followupRun,
          sessionCtx: {
            Provider: provider,
            OriginatingChannel: "telegram",
            OriginatingTo: "12345",
            MessageSid: messageId,
            MessageThreadId: "stale-topic",
          } as unknown as TemplateContext,
        }),
      );

      expect(result.kind).toBe("success");
      expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
        modelContextWindow: 400_000,
        modelContextTokens: 321_000,
        currentThreadTs: "42",
        currentMessageId,
        conversationToolPolicy: { allow: ["read", "sessions_spawn"], deny: ["exec"] },
        execOverrides: { host: "node", node: "mac-a" },
        bashElevated: { enabled: true, allowed: true, defaultLevel: "full" },
        runtimePolicySessionKey: "agent:main:telegram:default:direct:sender-static",
      });
    },
  );

  it("keeps untargeted message-tool sends from a thread turn in that thread", async () => {
    const plugin: ChannelPlugin = createChannelTestPluginBase({ id: "slack" });
    plugin.threading = {
      buildToolContext: ({ context }) => {
        const threadTs =
          context.MessageThreadId != null ? String(context.MessageThreadId) : undefined;
        return {
          currentChannelId: context.To,
          currentThreadTs: threadTs ?? String(context.CurrentMessageId),
          replyToMode: threadTs ? "all" : context.ReplyToMode,
          sameChannelThreadRequired: threadTs !== undefined,
        };
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "slack", plugin, source: "test" }]));
    try {
      const followupRun = createCliRun("claude-cli", "claude-opus-4-7");
      state.runCliAgentMock.mockResolvedValueOnce(cliResult("done", {}));
      const result = await executeAgentTurn(
        createMinimalRunAgentTurnParams({
          followupRun,
          sessionCtx: {
            Provider: "slack",
            OriginatingChannel: "slack",
            OriginatingTo: "channel:C123",
            ChatType: "channel",
            MessageSid: "1700000000.000200",
            ReplyToMode: "off",
            MessageThreadId: "1700000000.000100",
          } as unknown as TemplateContext,
        }),
      );
      expect(result.kind).toBe("success");
    } finally {
      resetPluginRuntimeStateForTest();
    }
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      currentThreadTs: "1700000000.000100",
      replyToMode: "all",
    });
  });

  it("keeps prepared current-turn images aligned with CLI media facts", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-5");
    const images = [
      {
        type: "image" as const,
        data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP4z8DwH4QZYAwAR8oH+Rq28akAAAAASUVORK5CYII=",
        mimeType: "image/png",
      },
    ];
    const imageOrder = ["inline" as const];
    const media = [{ path: "/openclaw-test-missing/current.png", contentType: "image/png" }];
    const mediaImageLayout = {
      slots: [{ kind: "inline" as const, factIndex: 0 }],
      suppressedFactIndexes: [],
    };
    state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
      expect(params.modelHasVision).toBe(true);
      const internalParams = params as RunCliAgentParams & {
        mediaImageLayout?: typeof mediaImageLayout;
      };
      const reconciled = await detectAndLoadPromptImages({
        prompt: params.prompt,
        media: params.media,
        workspaceDir: params.workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: params.images,
        imageOrder: params.imageOrder,
        mediaImageLayout: internalParams.mediaImageLayout,
      });
      expect(reconciled).toMatchObject({
        failedMediaCount: 0,
        images,
      });
      return cliResult("described", {});
    });
    followupRun.run.thinkingCatalog = [
      {
        provider: "claude-cli",
        id: "claude-opus-5",
        input: ["text", "image"],
      },
    ];
    const preparedFollowupRun = followupRun as typeof followupRun & {
      currentTurnImagesPrepared?: true;
      mediaImageLayout?: typeof mediaImageLayout;
    };
    preparedFollowupRun.currentTurnImagesPrepared = true;
    preparedFollowupRun.mediaImageLayout = mediaImageLayout;
    followupRun.images = images;
    followupRun.imageOrder = imageOrder;
    followupRun.media = media;

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "telegram",
          MessageSid: "msg",
          media,
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      images,
      imageOrder,
      mediaImageLayout,
      media,
    });
  });

  it("passes prepared CLI user turns to the runtime persistence boundary", async () => {
    const followupRun = createCliRun("codex-cli", "gpt-5.4");
    const recorder = createTestUserTurnRecorder({
      role: "user",
      content: "describe this",
      timestamp: 1,
    });
    followupRun.userTurnTranscriptRecorder = recorder;
    state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
      expect(params.userTurnTranscriptRecorder).toBe(recorder);
      expect(params.suppressNextUserMessagePersistence).toBe(false);
      expect(params.persistAssistantTranscript).toBe(true);
      expect(params.onUserMessagePersisted).toEqual(expect.any(Function));
      return cliResult("final", {});
    });
    expect((await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }))).kind).toBe(
      "success",
    );
  });

  it.each(["reused", "replacement", "unflushed"] as const)(
    "handles %s room-event CLI sessions",
    async (kind) => {
      const followupRun = createCliRun("codex-cli", "gpt-5.4");
      const reused = kind === "reused";
      const sessionId = reused
        ? "existing-cli-session"
        : kind === "replacement"
          ? "transient-cli-session"
          : "";
      state.runCliAgentMock.mockResolvedValueOnce(
        cliResult("ambient", {
          agentMeta: {
            sessionId,
            ...(kind === "unflushed"
              ? { provider: "codex-cli", model: "gpt-5.4" }
              : { cliSessionBinding: { sessionId, authProfileId: "profile" } }),
            ...(!reused ? { clearCliSessionBinding: true } : {}),
          },
        }),
      );
      followupRun.currentInboundEventKind = "room_event";
      const sessionEntry = {
        cliSessionBindings: { "codex-cli": { sessionId: "existing-cli-session" } },
      } as unknown as SessionEntry;
      const params = sessionParams(followupRun, sessionEntry);
      let cleanupObservedBeforePlacementRelease = false;
      const restoreAdmission =
        kind === "replacement"
          ? installSessionPlacementAdmissionProvider({
              assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
              executeLocalTurn: async (_claim, runLocal) => {
                const result = await runLocal();
                expect(
                  params.activeSessionStore.main.cliSessionBindings?.["codex-cli"],
                ).toBeUndefined();
                cleanupObservedBeforePlacementRelease = true;
                return result;
              },
              executeTurn: async (_claim, _params, runLocal) => await runLocal(),
            })
          : () => {};
      try {
        const result = await executeAgentTurn(params);
        expect(result.kind).toBe("success");
        if (result.kind !== "success") {
          throw new Error("expected success");
        }
        expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
          currentInboundEventKind: "room_event",
          cliSessionId: "existing-cli-session",
          cliSessionBinding: { sessionId: "existing-cli-session" },
          ...(reused ? { persistAssistantTranscript: false } : {}),
        });
        expect(result.runResult.meta?.agentMeta?.sessionId).toBe(reused ? sessionId : "");
        if (reused) {
          expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toEqual({
            sessionId,
            authProfileId: "profile",
          });
        } else {
          expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toBeUndefined();
          expect(result.runResult.meta?.agentMeta?.clearCliSessionBinding).toBeUndefined();
          expect(params.activeSessionStore.main.cliSessionBindings?.["codex-cli"]).toBeUndefined();
        }
        if (kind === "replacement") {
          expect(cleanupObservedBeforePlacementRelease).toBe(true);
        }
      } finally {
        restoreAdmission();
      }
    },
  );

  it("preserves a reused binding after an operator aborts a channel turn", async () => {
    const sessionKey = "agent:main:direct:aborted-run";
    const followupRun = createCliRun("claude-cli", "claude-opus-4-8");
    state.runCliAgentMock.mockRejectedValueOnce(
      Object.assign(new Error("CLI run aborted"), { name: "AbortError" }),
    );

    const sessionEntry = legacyCliSession("aborted-session");
    await executeAgentTurn(sessionParams(followupRun, sessionEntry, sessionKey));

    expect(sessionEntry.cliSessionBindings?.["claude-cli"]?.sessionId).toBe("aborted-session");
    expect(sessionEntry.cliSessionIds?.["claude-cli"]).toBe("aborted-session");
    expect(sessionEntry.claudeCliSessionId).toBe("aborted-session");
  });

  it("does not attribute media from an earlier admitted turn to a queued failure", async () => {
    const sessionKey = "agent:main:cron:media-job:run:run-queued";
    const followupRun = createCliRun("claude-cli", "claude-opus-4-8");
    state.runCliAgentMock.mockRejectedValueOnce(
      new FailoverError("queued session expired", {
        reason: "session_expired",
        provider: "claude-cli",
        model: "claude-opus-4-8",
      }),
    );

    const { resolve: releaseAdmission, promise: admissionGate } = createDeferred();
    const { resolve: notifyAdmissionWait, promise: admissionWait } = createDeferred();
    const restoreAdmission = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
      executeLocalTurn: async (_claim, runLocal) => {
        notifyAdmissionWait();
        await admissionGate;
        return await runLocal();
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });

    const sessionEntry = legacyCliSession("queued-stale-session");
    try {
      const runPromise = executeAgentTurn(sessionParams(followupRun, sessionEntry, sessionKey));
      await admissionWait;
      registerGeneratedMediaTaskActivity("tool:image_generate:earlier-turn", sessionKey);
      releaseAdmission();
      const result = await runPromise;

      expect(result.kind).toBe("final");
      expect(state.runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
        cliSessionId: "queued-stale-session",
      });
      expect(sessionEntry.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(sessionEntry.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(sessionEntry.claudeCliSessionId).toBeUndefined();
    } finally {
      releaseAdmission();
      restoreAdmission();
    }
  });
});
