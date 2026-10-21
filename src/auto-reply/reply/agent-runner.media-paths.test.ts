import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { createReplyOperation as createRegisteredReplyOperation } from "../../sessions/session-controller.operation.js";
import type { TemplateContext } from "../templating.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createMediaFollowupRun,
  createReplyMediaContextRuntimeMock as mediaContextMock,
  enqueueFollowupRunMock,
  makeRunReplyAgentParams as makeReplyParams,
  reserveSteerCandidateMock,
  parkedSteerConsumeMock,
  parkedSteerFallbackMock,
  backendQueueMessageMock as queueMessageMock,
  resolveOutboundAttachmentFromUrlMock,
  runEmbeddedAgentMock,
  runReplyAgent,
  tempDirs,
  testWorkspaceDir,
  resetAgentRunnerMediaTestState,
  cleanupAgentRunnerMediaTestState,
} from "./agent-runner.media-paths.test-harness.js";
import type { FollowupRun } from "./queue.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

describe("runReplyAgent media path normalization", () => {
  beforeEach(resetAgentRunnerMediaTestState);
  afterEach(cleanupAgentRunnerMediaTestState);

  it.each(["device-a", "device-b"])(
    "steers active non-streaming prompts from reviewer %s in steer queue mode",
    async (approvalReviewerDeviceId) => {
      queueMessageMock.mockImplementation(async (sessionId: string) => ({
        queued: true,
        sessionId,
        target: "embedded_run",
        gatewayHealth: "live",
      }));
      const followupRun = createMediaFollowupRun({ prompt: "generate chart" });
      followupRun.run.taskSuggestionDeliveryMode = "gateway";
      followupRun.run.approvalReviewerDeviceId = "device-a";

      const params = await makeReplyParams({
        resolvedQueue: { mode: "steer" },
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
        followupRun,
      });
      followupRun.run.approvalReviewerDeviceId = approvalReviewerDeviceId;

      await runReplyAgent(params);

      expect(queueMessageMock.mock.calls.map(([sessionId, prompt]) => [sessionId, prompt])).toEqual(
        [["session", "generate chart"]],
      );
      expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
      expect(parkedSteerConsumeMock).toHaveBeenCalledOnce();
      expect(parkedSteerFallbackMock).not.toHaveBeenCalled();
    },
  );

  const makeSteerParams = (overrides: Parameters<typeof makeReplyParams>[0] = {}) =>
    makeReplyParams({
      resolvedQueue: { mode: "steer" },
      shouldSteer: true,
      shouldFollowup: true,
      isActive: true,
      ...overrides,
    });
  const acceptSteer = () =>
    queueMessageMock.mockImplementation(async (sessionId: string) => ({
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
    }));
  function expectAcceptedSteer(prompt: string, options: unknown = expect.anything()) {
    expect(queueMessageMock).toHaveBeenCalledExactlyOnceWith("session", prompt, options);
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
    expect(parkedSteerConsumeMock).toHaveBeenCalledOnce();
    expect(parkedSteerFallbackMock).not.toHaveBeenCalled();
  }
  const makeSessionContext = () => ({
    Provider: "telegram",
    Surface: "telegram",
    To: "chat-1",
    OriginatingTo: "chat-1",
    AccountId: "default",
    MessageSid: "msg-1",
  });

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
      const params = await makeSteerParams({
        isRunActive: () => true,
        followupRun,
      });
      followupRun.run = {
        ...followupRun.run,
        ...run,
        approvalReviewerDeviceId: "device-b",
      };

      await runReplyAgent(params);

      expect(queueMessageMock).not.toHaveBeenCalled();
      expect(parkedSteerFallbackMock).toHaveBeenCalledOnce();
      expect(parkedSteerConsumeMock).not.toHaveBeenCalled();
      expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
      expect(reserveSteerCandidateMock).toHaveBeenCalledExactlyOnceWith(
        params.queueKey,
        followupRun,
        params.resolvedQueue,
        expect.any(Function),
      );
    },
  );

  it("does not wait on a queued command source when the target has no reply operation", async () => {
    const source = createRegisteredReplyOperation({
      sessionKey: "agent:main:slash:source",
      sessionId: "command-source",
      resetTriggered: false,
    });
    enqueueFollowupRunMock.mockReturnValueOnce(true);
    const params = await makeSteerParams({
      replyOperation: source,
      sessionKey: "main",
    });
    await runReplyAgent(params);
    expect(source).toMatchObject({ phase: "queued", abortSignal: { aborted: false } });
    expect(enqueueFollowupRunMock).toHaveBeenCalledExactlyOnceWith(
      params.queueKey,
      params.followupRun,
      params.resolvedQueue,
      "message-id",
      expect.any(Function),
      false,
    );
    expect(reserveSteerCandidateMock).not.toHaveBeenCalled();
    expect(queueMessageMock).not.toHaveBeenCalled();
  });

  it("steers ordered current-turn images and quoted context with the active prompt", async () => {
    acceptSteer();
    const images = [
      { type: "image" as const, data: "first", mimeType: "image/jpeg" },
      { type: "image" as const, data: "second", mimeType: "image/png" },
    ];
    const followupRun = createMediaFollowupRun({
      prompt: "compare these",
      images,
      currentInboundContext: { text: "Replied message: Which color for the invitation?" },
      media: [
        { path: "/tmp/first.jpg", contentType: "image/jpeg" },
        { path: "/tmp/second.png", contentType: "image/png" },
      ],
    });

    await runReplyAgent(await makeSteerParams({ followupRun }));

    expectAcceptedSteer(
      "compare these",
      expect.objectContaining({
        images,
        media: followupRun.media,
        currentInboundContext: followupRun.currentInboundContext,
      }),
    );
  });

  it("defers the complete image turn when the active runtime cannot preserve images", async () => {
    queueMessageMock.mockImplementation(async (sessionId: string) => ({
      queued: false,
      sessionId,
      reason: "image_input_unsupported",
      gatewayHealth: "live",
    }));
    const followupRun = createMediaFollowupRun({
      prompt: "inspect this",
      images: [{ type: "image", data: "png", mimeType: "image/png" }],
    });

    await runReplyAgent(await makeSteerParams({ followupRun }));

    expect(reserveSteerCandidateMock).toHaveBeenCalledWith(
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
    const followupRun = createMediaFollowupRun({
      prompt: "summarize the audio",
      currentInboundAudio: true,
    });
    const op = createRegisteredReplyOperation({
      sessionKey: "agent:main:whatsapp:direct:chat-1",
      sessionId: "session",
      resetTriggered: false,
    });
    op.setPhase("running");
    await op.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(followupRun));
    expect(op.acceptedSteeredInboundAudio).toBe(false);
    // An answer sent before this steer must not count as answering it.
    op.markSourceReplyDelivered();
    acceptSteer();

    await runReplyAgent(
      await makeSteerParams({
        followupRun,
        replyOperation: op,
        sessionKey: "agent:main:whatsapp:direct:chat-1",
      }),
    );

    expect(op).toMatchObject({ acceptedSteeredInboundAudio: true, sourceReplyDelivered: false });
    expectAcceptedSteer("summarize the audio");
  });

  it("queues active prompts in followup mode without steering", async () => {
    await runReplyAgent(
      await makeSteerParams({
        resolvedQueue: { mode: "followup" },
        shouldSteer: false,
        isRunActive: () => true,
      }),
    );

    expect(queueMessageMock).not.toHaveBeenCalled();
    expect(reserveSteerCandidateMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).toHaveBeenCalledOnce();
    expect(enqueueFollowupRunMock.mock.calls[0]?.[1].prompt).toBe("generate chart");
  });

  it("falls back to a queued followup when active steering is rejected", async () => {
    queueMessageMock.mockImplementation(async (sessionId: string) => ({
      queued: false,
      sessionId,
      reason: "runtime_rejected",
      gatewayHealth: "live",
      errorMessage: "cannot steer a compact turn",
    }));

    await runReplyAgent(await makeSteerParams({ isRunActive: () => true }));

    expect(queueMessageMock).toHaveBeenCalledOnce();
    expect(reserveSteerCandidateMock).toHaveBeenCalledWith(
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

  async function runTurn(
    sessionCtx: TemplateContext,
    prompt = "describe this image",
    overrides: Partial<AgentTurnParams> = {},
  ) {
    const { executeAgentTurn } = await import("./agent-runner-execution.js");
    const params: AgentTurnParams = {
      commandBody: prompt,
      followupRun:
        overrides.followupRun ??
        createMediaFollowupRun({
          prompt,
          run: {
            provider: "ollama",
            model: "gemma4:latest",
            workspaceDir: testWorkspaceDir,
          },
        }),
      sessionCtx,
      typingSignals: createTypingSignaler({
        typing: createMockTypingController(),
        mode: "instant",
        isHeartbeat: false,
      }),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
      replyMediaContext: { normalizePayload: async (payload) => payload },
      ...overrides,
    };
    setRuntimeConfigSnapshot(params.followupRun.run.config);
    return await executeAgentTurn(params);
  }

  it.each([true, false])(
    "keeps the prepared global owner in executeAgentTurn (provided context: %s)",
    async (providedContext) => {
      // Regression: #68056, block and final replies must share the caller's media cache.
      runEmbeddedAgentMock.mockResolvedValue({
        payloads: [],
        meta: { agentMeta: { sessionId: "session", provider: "anthropic", model: "claude" } },
      });

      const followupRun = createMediaFollowupRun({
        prompt: "generate",
        run: {
          agentId: "qa",
          sessionKey: "global",
          workspaceDir: testWorkspaceDir,
          config: { agents: { ownership: "explicit", entries: { qa: {}, beta: {} } } },
        },
      });
      setRuntimeConfigSnapshot(followupRun.run.config, followupRun.run.config);
      const result = await runTurn(makeSessionContext(), "generate", {
        followupRun,
        blockStreamingEnabled: true,
        sessionKey: "global",
        replyMediaContext: providedContext
          ? { normalizePayload: async (payload) => payload }
          : undefined,
      });

      if (providedContext) {
        expect(mediaContextMock).not.toHaveBeenCalled();
      } else {
        expect(mediaContextMock).toHaveBeenCalledOnce();
        expect(mediaContextMock).toHaveBeenCalledWith(
          expect.objectContaining({ cfg: followupRun.run.config, sessionKey: "global" }),
        );
      }
      expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["passes current inbound media as native images", false],
    ["retains resolved images and skips unresolved attachments", true],
  ] as const)("%s", async (_label, unresolvedAttachment) => {
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
      meta: { agentMeta: { sessionId: "session", provider: "ollama", model: "gemma4:latest" } },
    });

    const attachment = (file: string) => ({
      path: file,
      contentType: "image/png",
      workspaceDir: tmpDir,
    });
    await runTurn(
      {
        ...makeSessionContext(),
        media: [
          ...(unresolvedAttachment ? [attachment(path.join(tmpDir, "missing.png"))] : []),
          attachment(imagePath),
        ],
      } as unknown as TemplateContext,
      unresolvedAttachment ? "compare these images" : "describe this image",
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | Parameters<typeof runEmbeddedAgent>[0]
      | undefined;
    expect(call).toMatchObject({ modelHasVision: true, imageOrder: ["inline"] });
    expect(call?.images).toEqual([
      { type: "image", data: expect.any(String), mimeType: "image/png" },
    ]);
    expect(call?.images?.[0]?.data).toHaveLength(92);
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

    await runTurn(
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
});
