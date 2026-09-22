import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createMediaFollowupRun,
  createReplyMediaContextRuntimeMock,
  enqueueFollowupRunMock,
  makeRunReplyAgentParams,
  parkSteerCandidateMock,
  parkedSteerConsumeMock,
  parkedSteerFallbackMock,
  queueEmbeddedAgentMessageWithOutcomeAsyncMock,
  resolveOutboundAttachmentFromUrlMock,
  runEmbeddedAgentMock,
  runReplyAgent,
  tempDirs,
  testWorkspaceDir,
  resetAgentRunnerMediaTestState,
  cleanupAgentRunnerMediaTestState,
} from "./agent-runner.media-paths.test-harness.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createReplyOperation as createRegisteredReplyOperation } from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

describe("runReplyAgent media path normalization", () => {
  beforeEach(resetAgentRunnerMediaTestState);
  afterEach(cleanupAgentRunnerMediaTestState);

  it.each(["device-a", "device-b"])(
    "steers active non-streaming prompts from reviewer %s in steer queue mode",
    async (approvalReviewerDeviceId) => {
      queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(
        async (sessionId: string) => ({
          queued: true,
          sessionId,
          target: "embedded_run",
          gatewayHealth: "live",
        }),
      );
      const followupRun = createMediaFollowupRun({ prompt: "generate chart" });
      followupRun.run.taskSuggestionDeliveryMode = "gateway";
      followupRun.run.approvalReviewerDeviceId = "device-a";

      const params = makeRunReplyAgentParams({
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
        followupRun,
      });
      followupRun.run.approvalReviewerDeviceId = approvalReviewerDeviceId;

      await runReplyAgent(params);

      expect(
        queueEmbeddedAgentMessageWithOutcomeAsyncMock.mock.calls.map(([sessionId, prompt]) => [
          sessionId,
          prompt,
        ]),
      ).toEqual([["session", "generate chart"]]);
      expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
      expect(parkedSteerConsumeMock).toHaveBeenCalledOnce();
      expect(parkedSteerFallbackMock).not.toHaveBeenCalled();
    },
  );

  it.each(
    [
      {
        origin: "unmarked user",
        eventKind: undefined,
        provenance: undefined,
        isInboundUserMessage: true,
      },
      {
        origin: "external user",
        eventKind: "user_request" as const,
        provenance: { kind: "external_user" as const },
        isInboundUserMessage: true,
      },
      {
        origin: "room event",
        eventKind: "room_event" as const,
        provenance: { kind: "external_user" as const },
        isInboundUserMessage: false,
      },
      {
        origin: "inter-session message",
        eventKind: "user_request" as const,
        provenance: { kind: "inter_session" as const },
        isInboundUserMessage: false,
      },
    ].flatMap(({ origin, eventKind, provenance, isInboundUserMessage }) =>
      [true, false].map((accepted) => ({
        origin,
        eventKind,
        provenance,
        isInboundUserMessage,
        accepted,
      })),
    ),
  )(
    "preserves quoted context and $origin authority through steer admission (accepted: $accepted)",
    async ({ accepted, eventKind, provenance, isInboundUserMessage }) => {
      const followupRun = createMediaFollowupRun({ prompt: "Use the same color as before." });
      followupRun.currentInboundEventKind = eventKind;
      followupRun.run.inputProvenance = provenance;
      followupRun.run.terminalReplyExpectation = "required";
      followupRun.currentInboundContext = {
        text: 'Replied message (untrusted, for context):\n{"body":"Which color for the invitation?"}',
        fragments: [
          { kind: "conversation-data", text: "Replied message: Which color for the invitation?" },
        ],
      };
      queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId) =>
        accepted
          ? { queued: true, sessionId, target: "embedded_run", gatewayHealth: "live" }
          : { queued: false, sessionId, reason: "not_streaming", gatewayHealth: "live" },
      );

      await runReplyAgent(
        makeRunReplyAgentParams({
          resolvedQueue: { mode: "steer" },
          shouldSteer: true,
          shouldFollowup: true,
          isActive: true,
          followupRun,
        }),
      );

      expect(queueEmbeddedAgentMessageWithOutcomeAsyncMock).toHaveBeenCalledWith(
        "session",
        followupRun.prompt,
        expect.objectContaining({
          currentInboundContext: followupRun.currentInboundContext,
          isInboundUserMessage,
          terminalReplyExpectation: followupRun.run.terminalReplyExpectation,
        }),
      );
      expect(parkSteerCandidateMock).toHaveBeenCalledWith(
        "main",
        followupRun,
        { mode: "steer" },
        expect.any(Function),
      );
      expect(parkedSteerFallbackMock).toHaveBeenCalledTimes(accepted ? 0 : 1);
      expect(followupRun.prompt).toBe("Use the same color as before.");
    },
  );

  it.each([
    { label: "permission mode", run: { permissionMode: "guarded" } },
    { label: "tool overrides", run: { toolOverrides: { webSearch: false } } },
    { label: "execution policy", run: { execOverrides: { security: "deny" } } },
    { label: "elevation", run: { elevatedLevel: "full" } },
    {
      label: "shell elevation",
      run: { bashElevated: { enabled: true, allowed: true, defaultLevel: "full" } },
    },
    { label: "workspace", run: { workspaceDir: "/tmp/different-steering-workspace" } },
    { label: "client capabilities", run: { clientCaps: ["changed-capability"] } },
    {
      label: "tool bindings",
      run: { toolBindings: { browser: { clientId: "different-browser" } } },
    },
  ] satisfies { label: string; run: Partial<FollowupRun["run"]> }[])(
    "queues a different browser's prompt when its $label differs",
    async ({ run }) => {
      const followupRun = createMediaFollowupRun({
        prompt: "generate chart",
        run: { permissionMode: "full", approvalReviewerDeviceId: "device-a" },
      });
      const params = makeRunReplyAgentParams({
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
        isRunActive: () => true,
        followupRun,
      });
      followupRun.run = {
        ...followupRun.run,
        ...run,
        approvalReviewerDeviceId: "device-b",
      };

      await runReplyAgent(params);

      expect(queueEmbeddedAgentMessageWithOutcomeAsyncMock).not.toHaveBeenCalled();
      expect(parkSteerCandidateMock).not.toHaveBeenCalled();
      expect(enqueueFollowupRunMock).toHaveBeenCalledOnce();
      expect(enqueueFollowupRunMock.mock.calls[0]?.[1]).toBe(followupRun);
    },
  );

  it("steers ordered current-turn images with the active prompt", async () => {
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId: string) => ({
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
    }));
    const images = [
      { type: "image" as const, data: "first", mimeType: "image/jpeg" },
      { type: "image" as const, data: "second", mimeType: "image/png" },
    ];
    const followupRun = createMediaFollowupRun({ prompt: "compare these" });
    followupRun.images = images;
    followupRun.media = [
      { path: "/tmp/first.jpg", contentType: "image/jpeg" },
      { path: "/tmp/second.png", contentType: "image/png" },
    ];

    await runReplyAgent(
      makeRunReplyAgentParams({
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
        followupRun,
      }),
    );

    expect(
      queueEmbeddedAgentMessageWithOutcomeAsyncMock.mock.calls.map(([sessionId, prompt]) => [
        sessionId,
        prompt,
      ]),
    ).toEqual([["session", "compare these"]]);
    expect(queueEmbeddedAgentMessageWithOutcomeAsyncMock.mock.calls[0]?.[2]).toMatchObject({
      images,
      media: followupRun.media,
    });
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
    expect(parkedSteerConsumeMock).toHaveBeenCalledOnce();
    expect(parkedSteerFallbackMock).not.toHaveBeenCalled();
  });

  it("defers the complete image turn when the active runtime cannot preserve images", async () => {
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId: string) => ({
      queued: false,
      sessionId,
      reason: "image_input_unsupported",
      gatewayHealth: "live",
    }));
    const images = [{ type: "image" as const, data: "png", mimeType: "image/png" }];
    const followupRun = createMediaFollowupRun({ prompt: "inspect this" });
    followupRun.images = images;

    await runReplyAgent(
      makeRunReplyAgentParams({
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
        followupRun,
      }),
    );

    expect(parkSteerCandidateMock).toHaveBeenCalledWith(
      "main",
      followupRun,
      expect.objectContaining({ mode: "steer" }),
      expect.any(Function),
    );
    expect(parkedSteerFallbackMock).toHaveBeenCalledOnce();
    expect(parkedSteerConsumeMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
  });

  it("latches audio only after the active reply operation accepts the steer", async () => {
    const followupRun = {
      ...createMediaFollowupRun({ prompt: "summarize the audio" }),
      currentInboundAudio: true,
    } as unknown as FollowupRun;
    const operation = createRegisteredReplyOperation({
      sessionKey: "agent:main:whatsapp:direct:chat-1",
      sessionId: "session",
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
    expect(operation.acceptedSteeredInboundAudio).toBe(false);
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId: string) => ({
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
    }));

    await runReplyAgent(
      makeRunReplyAgentParams({
        followupRun,
        replyOperation: operation,
        sessionKey: "agent:main:whatsapp:direct:chat-1",
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
      }),
    );

    expect(operation.acceptedSteeredInboundAudio).toBe(true);
    expect(
      queueEmbeddedAgentMessageWithOutcomeAsyncMock.mock.calls.map(([sessionId, prompt]) => [
        sessionId,
        prompt,
      ]),
    ).toEqual([["session", "summarize the audio"]]);
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
    expect(parkedSteerConsumeMock).toHaveBeenCalledOnce();
    expect(parkedSteerFallbackMock).not.toHaveBeenCalled();
  });

  it("queues active prompts in followup mode without steering", async () => {
    await runReplyAgent(
      makeRunReplyAgentParams({
        resolvedQueue: { mode: "followup" } as QueueSettings,
        shouldSteer: false,
        shouldFollowup: true,
        isActive: true,
        isRunActive: () => true,
      }),
    );

    expect(queueEmbeddedAgentMessageWithOutcomeAsyncMock).not.toHaveBeenCalled();
    expect(parkSteerCandidateMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).toHaveBeenCalledOnce();
    expect(enqueueFollowupRunMock.mock.calls[0]?.[1].prompt).toBe("generate chart");
  });

  it("falls back to a queued followup when active steering is rejected", async () => {
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId: string) => ({
      queued: false,
      sessionId,
      reason: "runtime_rejected",
      gatewayHealth: "live",
      errorMessage: "cannot steer a compact turn",
    }));

    await runReplyAgent(
      makeRunReplyAgentParams({
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
        isRunActive: () => true,
      }),
    );

    expect(parkSteerCandidateMock).toHaveBeenCalledWith(
      "main",
      expect.objectContaining({ prompt: "generate chart" }),
      expect.objectContaining({ mode: "steer" }),
      expect.any(Function),
    );
    expect(parkedSteerFallbackMock).toHaveBeenCalledOnce();
    expect(parkedSteerConsumeMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
  });

  it("shares one media cache between block accumulation and final payload delivery", async () => {
    const { createReplyMediaContext } =
      await vi.importActual<typeof import("./reply-media-paths.js")>("./reply-media-paths.js");
    const mediaContext = createReplyMediaContext({
      cfg: {},
      sessionKey: "main",
      workspaceDir: testWorkspaceDir,
      messageProvider: "telegram",
      accountId: "default",
    });
    let stagedIndex = 0;
    resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => {
      stagedIndex += 1;
      return {
        path: path.join("/tmp/outbound-media", `${stagedIndex}-${path.basename(mediaUrl)}`),
      };
    });

    const blockPayload = await mediaContext.normalizePayload({
      text: "here is the chart",
      mediaUrl: "./out/chart.png",
      mediaUrls: ["./out/chart.png"],
    });
    const finalPayload = await mediaContext.normalizePayload({
      text: "here is the chart",
      mediaUrl: "./out/chart.png",
      mediaUrls: ["./out/chart.png"],
    });

    expect(blockPayload).toEqual({
      text: "here is the chart",
      mediaUrl: "/tmp/outbound-media/1-chart.png",
      mediaUrls: ["/tmp/outbound-media/1-chart.png"],
      attachments: [{ name: "chart.png", mimeType: "image/png", trustedLocalMedia: true }],
      trustedLocalMedia: true,
    });
    expect(finalPayload).toEqual(blockPayload);
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledTimes(1);
  });

  async function runAgentTurnWithSessionContext(
    sessionCtx: TemplateContext,
    prompt = "describe this image",
    overrides: Partial<AgentTurnParams> = {},
  ) {
    const { executeAgentTurn } = await import("./agent-runner-execution.js");
    return await executeAgentTurn({
      commandBody: prompt,
      followupRun:
        overrides.followupRun ??
        createMediaFollowupRun({
          prompt,
          run: {
            provider: "ollama",
            model: "gemma4:latest",
            thinkingCatalog: [
              { provider: "ollama", id: "gemma4:latest", input: ["text", "image"] },
            ],
            workspaceDir: testWorkspaceDir,
            config: {},
          },
        }),
      sessionCtx,
      typingSignals: {
        mode: "instant",
        shouldStartImmediately: true,
        shouldStartOnMessageStart: false,
        shouldStartOnText: true,
        shouldStartOnReasoning: false,
        signalRunStart: async () => {},
        signalMessageStart: async () => {},
        signalTextDelta: async () => {},
        signalReasoningDelta: async () => {},
        signalToolStart: async () => {},
      },
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
      replyMediaContext: {
        normalizePayload: async (payload) => payload,
      },
      ...overrides,
    });
  }

  it.each([true, false])(
    "keeps the prepared global owner in executeAgentTurn (provided context: %s)",
    async (providedContext) => {
      // Regression test for openclaw/openclaw#68056.
      // executeAgentTurn must use the caller-provided context so block
      // replies and final replies can share one media cache.
      runEmbeddedAgentMock.mockResolvedValue({
        payloads: [],
        meta: {
          agentMeta: {
            sessionId: "session",
            provider: "anthropic",
            model: "claude",
          },
        },
      });

      const followupRun = createMediaFollowupRun({
        prompt: "generate",
        run: {
          agentId: "qa",
          sessionKey: "global",
          provider: "anthropic",
          model: "claude",
          thinkingCatalog: [{ provider: "anthropic", id: "claude", input: ["text"] }],
          workspaceDir: testWorkspaceDir,
          config: { agents: { ownership: "explicit", entries: { qa: {}, beta: {} } } },
        },
      });
      setRuntimeConfigSnapshot(followupRun.run.config, followupRun.run.config);
      const result = await runAgentTurnWithSessionContext(
        {
          Provider: "telegram",
          Surface: "telegram",
          To: "chat-1",
          OriginatingTo: "chat-1",
          AccountId: "default",
          MessageSid: "msg-1",
        },
        "generate",
        {
          followupRun,
          blockStreamingEnabled: true,
          sessionKey: "global",
          replyMediaContext: providedContext
            ? {
                normalizePayload: async (payload) => payload,
              }
            : undefined,
        },
      );

      // The .runtime import is only used by agent-runner-execution.ts. This path
      // should never create its own media context when the caller provides one.
      if (providedContext) {
        expect(createReplyMediaContextRuntimeMock).not.toHaveBeenCalled();
      } else {
        expect(createReplyMediaContextRuntimeMock).toHaveBeenCalledOnce();
        expect(createReplyMediaContextRuntimeMock).toHaveBeenCalledWith(
          expect.objectContaining({ cfg: followupRun.run.config, sessionKey: "global" }),
        );
      }
      expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    },
  );

  it("passes current inbound media paths as native OpenClaw images", async () => {
    const tmpDir = tempDirs.make("openclaw-native-agent-media-");
    const imagePath = path.join(tmpDir, "photo.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "ollama",
          model: "gemma4:latest",
        },
      },
    });

    await runAgentTurnWithSessionContext({
      Provider: "telegram",
      Surface: "telegram",
      To: "chat-1",
      OriginatingTo: "chat-1",
      AccountId: "default",
      MessageSid: "msg-1",
      media: [{ path: imagePath, contentType: "image/png", workspaceDir: tmpDir }],
    } as unknown as TemplateContext);

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | {
          images?: Array<{ type?: string; data?: string; mimeType?: string }>;
          imageOrder?: string[];
        }
      | undefined;
    expect(call).toMatchObject({ modelHasVision: true });
    expect(call?.images).toEqual([
      {
        type: "image",
        data: expect.any(String),
        mimeType: "image/png",
      },
    ]);
    expect(call?.images?.[0]?.data).toHaveLength(92);
    expect(call?.imageOrder).toEqual(["inline"]);
  });

  it("does not pass recent history images as unlabeled native OpenClaw images", async () => {
    const tmpDir = tempDirs.make("openclaw-native-agent-history-");
    const imagePath = path.join(tmpDir, "recent.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "ollama",
          model: "gemma4:latest",
        },
      },
    });

    await runAgentTurnWithSessionContext(
      {
        Provider: "telegram",
        Surface: "telegram",
        To: "chat-1",
        OriginatingTo: "chat-1",
        AccountId: "default",
        MessageSid: "msg-1",
        Timestamp: 1_700_000_000_000,
        InboundHistory: [
          {
            sender: "alice",
            body: "<media:image>",
            timestamp: 1_700_000_000_000,
            media: [{ path: imagePath, contentType: "image/png", kind: "image" }],
          },
        ],
      } as unknown as TemplateContext,
      "what did we discuss?",
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | {
          images?: Array<{ type?: string; data?: string; mimeType?: string }>;
          imageOrder?: string[];
        }
      | undefined;
    expect(call?.images).toBeUndefined();
    expect(call?.imageOrder).toBeUndefined();
  });

  it("retains resolved current images and skips unresolved attachments", async () => {
    const tmpDir = tempDirs.make("openclaw-native-agent-partial-");
    const imagePath = path.join(tmpDir, "present.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "ollama",
          model: "gemma4:latest",
        },
      },
    });

    await runAgentTurnWithSessionContext(
      {
        Provider: "telegram",
        Surface: "telegram",
        To: "chat-1",
        OriginatingTo: "chat-1",
        AccountId: "default",
        MessageSid: "msg-1",
        media: [
          {
            path: path.join(tmpDir, "missing.png"),
            contentType: "image/png",
            workspaceDir: tmpDir,
          },
          { path: imagePath, contentType: "image/png", workspaceDir: tmpDir },
        ],
      } as unknown as TemplateContext,
      "compare these images",
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | {
          images?: Array<{ type?: string; data?: string; mimeType?: string }>;
          imageOrder?: string[];
        }
      | undefined;
    expect(call?.images).toHaveLength(1);
    expect(call?.images?.[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(call?.imageOrder).toEqual(["inline"]);
  });
});
