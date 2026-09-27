import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCliPromptImagePayload } from "../../agents/cli-runner/helpers.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { detectAndLoadPromptImages } from "../../agents/embedded-agent-runner/run/images.js";
import { FailoverError } from "../../agents/failover-error.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { registerGeneratedMediaTaskActivity } from "../../tasks/generated-media-task-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../../tasks/task-runtime.test-helpers.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  createTestUserTurnRecorder,
  requireRecord,
  requireMockCall,
  expectMockCallArgFields,
  initialFallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
  createRunAgentTurnParams,
  makeTestSessionStorePath,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

function createCliRun(provider: string, model: string) {
  state.isCliProviderMock.mockReturnValue(true);
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
    result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
    provider,
    model,
    attempts: [],
  }));
  const followupRun = createFollowupRun();
  followupRun.run.provider = provider;
  followupRun.run.model = model;
  return followupRun;
}
afterEach(resetGeneratedMediaTaskActivityForTests);

function rejectUnexpectedCompactionSuccessor(): never {
  throw new Error("Unexpected compaction successor during CLI session routing test");
}

describe("executeAgentTurn: CLI session routing", () => {
  it("carries prepared model and thread context facts into CLI execution", async () => {
    const followupRun = createCliRun("claude-cli", "claude-sonnet-4-6");
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {},
    });
    followupRun.originatingThreadId = 42;
    followupRun.run.thinkingCatalog = [
      {
        provider: "claude-cli",
        id: "claude-sonnet-4-6",
        contextWindow: 400_000,
        contextTokens: 321_000,
        input: ["text", "image"],
      },
    ];

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "telegram",
          MessageSid: "msg",
          MessageThreadId: "stale-topic",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      modelContextWindow: 400_000,
      modelContextTokens: 321_000,
      currentThreadTs: "42",
    });
  });

  it("preserves queued image fields from runs created before the prepared marker", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-5");
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "described" }],
      meta: {},
    });
    const images = [
      {
        type: "image" as const,
        data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8Dwn4GBgYGJAQoAHxcCAr7cGDwAAAAASUVORK5CYII=",
        mimeType: "image/png",
      },
    ];
    const imageOrder = ["inline" as const];
    followupRun.images = images;
    followupRun.imageOrder = imageOrder;

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "telegram",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      images,
      imageOrder,
    });
  });

  it("keeps prepared current-turn images aligned with CLI media facts", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-5");
    const images = [
      {
        type: "image" as const,
        data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8Dwn4GBgYGJAQoAHxcCAr7cGDwAAAAASUVORK5CYII=",
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
      await expect(
        prepareCliPromptImagePayload({
          backend: { command: "claude" },
          prompt: params.prompt,
          imagePrompt: params.prompt,
          workspaceDir: params.workspaceDir,
          images: [...images, ...images],
          imageOrder: [...imageOrder, ...imageOrder],
          media,
        }),
      ).rejects.toThrow("failed to hydrate 1 structured image attachment");

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
      return {
        payloads: [{ text: "described" }],
        meta: {},
      };
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
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

  it("forwards the static extra system prompt to CLI backends", async () => {
    const followupRun = createCliRun("codex-cli", "gpt-5.4");
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    followupRun.run.agentId = "main";
    followupRun.run.extraSystemPrompt = "dynamic inbound metadata\n\nstable group prompt";
    followupRun.run.extraSystemPromptStatic = "stable group prompt";
    followupRun.run.senderId = "sender-static";
    followupRun.run.senderName = "Sender Static";
    followupRun.run.senderUsername = "sender-static-user";
    followupRun.run.senderE164 = "+15550002222";
    followupRun.run.execOverrides = { host: "node", node: "mac-a" };
    followupRun.run.bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "full",
    };
    followupRun.run.groupId = "group-static";
    followupRun.run.groupChannel = "ops";
    followupRun.run.groupSpace = "workspace-static";
    followupRun.run.spawnedBy = "agent:main:telegram:group:parent";
    followupRun.run.runtimePolicySessionKey = "agent:main:telegram:default:direct:sender-static";
    followupRun.originatingChannel = "telegram";

    const result = await executeAgentTurn(createRunAgentTurnParams(followupRun));

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      modelProvider: "codex-cli",
      extraSystemPrompt: "dynamic inbound metadata\n\nstable group prompt",
      extraSystemPromptStatic: "stable group prompt",
      trigger: "user",
      messageChannel: "telegram",
      messageProvider: "telegram",
      senderId: "sender-static",
      senderName: "Sender Static",
      senderUsername: "sender-static-user",
      senderE164: "+15550002222",
      execOverrides: { host: "node", node: "mac-a" },
      bashElevated: { enabled: true, allowed: true, defaultLevel: "full" },
      groupId: "group-static",
      groupChannel: "ops",
      groupSpace: "workspace-static",
      spawnedBy: "agent:main:telegram:group:parent",
      runtimePolicySessionKey: "agent:main:telegram:default:direct:sender-static",
    });
  });

  it("passes prepared CLI user turns to the runtime persistence boundary", async () => {
    const followupRun = createCliRun("codex-cli", "gpt-5.4");
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const preparedUserTurnMessage = {
      role: "user",
      content: "describe this",
      MediaPath: "/tmp/image.png",
      MediaPaths: ["/tmp/image.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    } as never;
    followupRun.userTurnTranscriptRecorder = createTestUserTurnRecorder(preparedUserTurnMessage);
    const storePath = makeTestSessionStorePath();
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      updatedAt: 1,
    };
    await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, sessionEntry);
    const activeSessionStore = { main: sessionEntry };

    await replaceSessionEntry({ sessionKey: "main", storePath }, sessionEntry);
    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      commandBody: "runtime prompt",
      transcriptCommandBody: "display prompt",
      activeSessionStore,
      storePath,
      getActiveSessionEntry: () => activeSessionStore.main,
    });

    expect(result.kind).toBe("success");
    expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI runtime", {
      sessionKey: "main",
      agentId: "main",
      sessionId: "session",
      suppressNextUserMessagePersistence: false,
      persistAssistantTranscript: true,
      storePath,
      sessionTarget: {
        agentId: "main",
        sessionId: "session",
        sessionKey: "main",
        storePath,
      },
    });
    const call = requireMockCall(state.runCliAgentMock, 0, "CLI runtime");
    const callParams = requireRecord(call[0], "CLI runtime");
    expect(callParams.userTurnTranscriptRecorder).toEqual(expect.any(Object));
    expect(requireRecord(callParams.userTurnTranscriptRecorder, "user turn recorder").message).toBe(
      preparedUserTurnMessage,
    );
    expect(callParams.onUserMessagePersisted).toEqual(expect.any(Function));
  });

  it("reuses CLI sessions for room-event turns", async () => {
    const followupRun = createCliRun("codex-cli", "gpt-5.4");
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ambient" }],
      meta: {
        agentMeta: {
          sessionId: "existing-cli-session",
          cliSessionBinding: {
            sessionId: "existing-cli-session",
            authProfileId: "profile",
          },
        },
      },
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    followupRun.currentInboundEventKind = "room_event";
    const sessionEntry = {
      cliSessionBindings: {
        "codex-cli": { sessionId: "existing-cli-session" },
      },
    } as unknown as SessionEntry;
    const activeSessionStore = { main: sessionEntry };

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      currentInboundEventKind: "room_event",
      persistAssistantTranscript: false,
      cliSessionId: "existing-cli-session",
      cliSessionBinding: {
        sessionId: "existing-cli-session",
      },
    });
    if (result.kind !== "success") {
      throw new Error("expected success");
    }
    expect(result.runResult.meta?.agentMeta?.sessionId).toBe("existing-cli-session");
    expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toEqual({
      sessionId: "existing-cli-session",
      authProfileId: "profile",
    });
  });

  it("keeps the first CLI session created by a room-event turn", async () => {
    const followupRun = createCliRun("codex-cli", "gpt-5.4");
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ambient" }],
      meta: {
        agentMeta: {
          sessionId: "new-cli-session",
          cliSessionBinding: {
            sessionId: "new-cli-session",
            authProfileId: "profile",
          },
        },
      },
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    followupRun.currentInboundEventKind = "room_event";
    const sessionEntry = {} as unknown as SessionEntry;

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      currentInboundEventKind: "room_event",
      cliSessionId: undefined,
      cliSessionBinding: undefined,
    });
    if (result.kind !== "success") {
      throw new Error("expected success");
    }
    expect(result.runResult.meta?.agentMeta?.sessionId).toBe("new-cli-session");
    expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toEqual({
      sessionId: "new-cli-session",
      authProfileId: "profile",
    });
  });

  it("drops replacement room-event CLI sessions when reuse fails", async () => {
    const followupRun = createCliRun("codex-cli", "gpt-5.4");
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ambient" }],
      meta: {
        agentMeta: {
          sessionId: "transient-cli-session",
          cliSessionBinding: {
            sessionId: "transient-cli-session",
            authProfileId: "profile",
          },
          clearCliSessionBinding: true,
        },
      },
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    followupRun.currentInboundEventKind = "room_event";
    const sessionEntry = {
      cliSessionBindings: {
        "codex-cli": { sessionId: "existing-cli-session" },
      },
    } as unknown as SessionEntry;
    const activeSessionStore = { main: sessionEntry };
    let cleanupObservedBeforePlacementRelease = false;
    const restoreAdmission = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
      executeLocalTurn: async (_claim, runLocal) => {
        const resultLocal = await runLocal();
        expect(activeSessionStore.main.cliSessionBindings?.["codex-cli"]).toBeUndefined();
        cleanupObservedBeforePlacementRelease = true;
        return resultLocal;
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });

    let result: Awaited<ReturnType<typeof executeAgentTurn>>;
    try {
      result = await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun }),
        activeSessionStore,
        getActiveSessionEntry: () => sessionEntry,
      });
    } finally {
      restoreAdmission();
    }

    expect(result.kind).toBe("success");
    expect(cleanupObservedBeforePlacementRelease).toBe(true);
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      currentInboundEventKind: "room_event",
      cliSessionId: "existing-cli-session",
      cliSessionBinding: {
        sessionId: "existing-cli-session",
      },
    });
    if (result.kind !== "success") {
      throw new Error("expected success");
    }
    expect(result.runResult.meta?.agentMeta?.sessionId).toBe("");
    expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toBeUndefined();
    expect(result.runResult.meta?.agentMeta?.clearCliSessionBinding).toBeUndefined();
    expect(activeSessionStore.main.cliSessionBindings?.["codex-cli"]).toBeUndefined();
  });

  it("keeps room-event CLI bindings when synthetic hooks return no CLI binding", async () => {
    const followupRun = createCliRun("codex-cli", "gpt-5.4");
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "handled" }],
      meta: {
        agentMeta: {
          sessionId: "openclaw-session",
          provider: "codex-cli",
          model: "gpt-5.4",
        },
      },
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    followupRun.currentInboundEventKind = "room_event";
    const sessionEntry = {
      cliSessionBindings: {
        "codex-cli": { sessionId: "existing-cli-session" },
      },
    } as unknown as SessionEntry;
    const activeSessionStore = { main: sessionEntry };

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") {
      throw new Error("expected success");
    }
    expect(result.runResult.meta?.agentMeta?.sessionId).toBe("");
    expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toBeUndefined();
    expect(activeSessionStore.main.cliSessionBindings?.["codex-cli"]).toEqual({
      sessionId: "existing-cli-session",
    });
  });

  it("clears room-event CLI bindings when an unflushed replacement is dropped", async () => {
    const followupRun = createCliRun("codex-cli", "gpt-5.4");
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "handled" }],
      meta: {
        agentMeta: {
          sessionId: "",
          provider: "codex-cli",
          model: "gpt-5.4",
          clearCliSessionBinding: true,
        },
      },
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    followupRun.currentInboundEventKind = "room_event";
    const sessionEntry = {
      cliSessionBindings: {
        "codex-cli": { sessionId: "existing-cli-session" },
      },
    } as unknown as SessionEntry;
    const activeSessionStore = { main: sessionEntry };

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") {
      throw new Error("expected success");
    }
    expect(result.runResult.meta?.agentMeta?.sessionId).toBe("");
    expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toBeUndefined();
    expect(result.runResult.meta?.agentMeta?.clearCliSessionBinding).toBeUndefined();
    expect(activeSessionStore.main.cliSessionBindings?.["codex-cli"]).toBeUndefined();
  });

  it("clears a fork-marked Claude CLI binding when the channel turn fails", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-8");
    state.runCliAgentMock.mockRejectedValueOnce(
      new FailoverError("No conversation found", {
        reason: "session_expired",
        provider: "claude-cli",
        model: "claude-opus-4-8",
      }),
    );

    const sessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: 1,
      cliSessionBindings: {
        "claude-cli": { sessionId: "stale-cli-session", forkNextResume: true },
      },
      cliSessionIds: { "claude-cli": "stale-cli-session" },
      claudeCliSessionId: "stale-cli-session",
    } as SessionEntry;
    const activeSessionStore = { main: sessionEntry };
    const executeAgentTurn = await getExecuteAgentTurnForTest();

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("final");
    expect(sessionEntry.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(sessionEntry.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(sessionEntry.claudeCliSessionId).toBeUndefined();
  });

  it("preserves a reused binding after a channel turn starts detached media", async () => {
    const sessionKey = "agent:main:cron:media-job:run:run-1";
    const followupRun = createCliRun("claude-cli", "claude-opus-4-8");
    const abort = Object.assign(new Error("detached media continues"), { name: "AbortError" });
    state.runCliAgentMock.mockImplementationOnce(async () => {
      registerGeneratedMediaTaskActivity("tool:image_generate:run-1", sessionKey);
      throw abort;
    });

    const sessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: 1,
      cliSessionBindings: { "claude-cli": { sessionId: "media-session" } },
      cliSessionIds: { "claude-cli": "media-session" },
      claudeCliSessionId: "media-session",
    } as SessionEntry;
    const activeSessionStore = { [sessionKey]: sessionEntry };
    const executeAgentTurn = await getExecuteAgentTurnForTest();

    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      sessionKey,
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(sessionEntry.cliSessionBindings?.["claude-cli"]?.sessionId).toBe("media-session");
    expect(sessionEntry.cliSessionIds?.["claude-cli"]).toBe("media-session");
    expect(sessionEntry.claudeCliSessionId).toBe("media-session");
  });

  it("preserves a reused binding after an operator aborts a channel turn", async () => {
    const sessionKey = "agent:main:direct:aborted-run";
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        "claude-cli",
        "claude-opus-4-8",
        initialFallbackAttemptOptions(params),
      ),
      provider: "claude-cli",
      model: "claude-opus-4-8",
      attempts: [],
    }));
    state.runCliAgentMock.mockRejectedValueOnce(
      Object.assign(new Error("CLI run aborted"), { name: "AbortError" }),
    );

    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-8";
    const sessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: 1,
      cliSessionBindings: { "claude-cli": { sessionId: "aborted-session" } },
      cliSessionIds: { "claude-cli": "aborted-session" },
      claudeCliSessionId: "aborted-session",
    } as SessionEntry;
    const activeSessionStore = { [sessionKey]: sessionEntry };
    const executeAgentTurn = await getExecuteAgentTurnForTest();

    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      sessionKey,
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

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

    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let notifyAdmissionWait!: () => void;
    const admissionWait = new Promise<void>((resolve) => {
      notifyAdmissionWait = resolve;
    });
    const restoreAdmission = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
      executeLocalTurn: async (_claim, runLocal) => {
        notifyAdmissionWait();
        await admissionGate;
        return await runLocal();
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });

    const sessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: 1,
      cliSessionBindings: { "claude-cli": { sessionId: "queued-stale-session" } },
      cliSessionIds: { "claude-cli": "queued-stale-session" },
      claudeCliSessionId: "queued-stale-session",
    } as SessionEntry;
    const activeSessionStore = { [sessionKey]: sessionEntry };
    const executeAgentTurn = await getExecuteAgentTurnForTest();

    try {
      const runPromise = executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun }),
        sessionKey,
        activeSessionStore,
        getActiveSessionEntry: () => sessionEntry,
      });
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
