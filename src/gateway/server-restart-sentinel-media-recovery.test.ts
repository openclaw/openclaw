import "./server-restart-sentinel.test-harness.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import type { RuntimeContextFragment } from "../agents/internal-runtime-context.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import {
  appendTranscriptMessage,
  loadSessionEntry as loadStoredSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  createRestartSentinelTestFixture,
  sessionFixture,
} from "./server-restart-sentinel-fixtures.test-support.js";

describe("restart generated-media recovery", () => {
  const fixture = createRestartSentinelTestFixture();
  const { mocks, deliverGeneratedMedia, expectQueueContext } = fixture;
  const expectedGeneratedMediaContext: RuntimeContextFragment[] = [
    {
      kind: "runtime-instruction",
      text: "Deliver the generated media listed below to the user.",
    },
    { kind: "conversation-data", text: "Generated media:\nMEDIA:/tmp/proof.png" },
  ];
  it("replays generated-media provenance through the owning session agent", async () => {
    const resolveGatewayContext = () => undefined;
    await deliverGeneratedMedia(
      {
        id: "session-delivery-media",
        messageId: "image:task-1:agent-loop",
        route: {
          channel: "discord",
          to: "channel:123",
          accountId: "default",
          chatType: "channel",
        },
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "image_generate:task-1",
          sourceChannel: "internal",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/proof.png"],
        idempotencyKey: "image:task-1:agent-loop",
      },
      "/tmp/custom-session-delivery-state",
      resolveGatewayContext,
    );

    expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      {
        sessionKey: "agent:main:main",
        message: "generated image ready",
        deliver: true,
        bestEffortDeliver: false,
        channel: "discord",
        accountId: "default",
        to: "channel:123",
        threadId: undefined,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "image_generate:task-1",
          sourceChannel: "internal",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "automatic",
        disableMessageTool: true,
        forceRestartSafeTools: true,
        idempotencyKey: "image:task-1:agent-loop",
      },
      {
        expectFinal: true,
        forceSyntheticClient: true,
        internalDeliveryMediaUrls: ["/tmp/proof.png"],
        runtimeContextFragments: expectedGeneratedMediaContext,
        resolveGatewayContext,
        onAccepted: expect.any(Function),
      },
    );
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(mocks.markSessionDeliveryAttemptStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-delivery-media", kind: "agentTurn" }),
      expectQueueContext("/tmp/custom-session-delivery-state"),
    );
  });

  it("keeps a generated-media gateway rejection before acceptance retryable", async () => {
    mocks.dispatchGatewayMethodInProcess.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-pre-accept",
        messageId: "image:task-pre-accept:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("failed before gateway acceptance");

    expect(mocks.markSessionDeliveryAttemptStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-delivery-media-pre-accept" }),
      expectQueueContext(),
    );
    expect(mocks.markSessionDeliverySettlement).not.toHaveBeenCalled();
  });

  it("authorizes queued media replay for an active cron continuation", async () => {
    mocks.loadSessionEntry.mockReturnValue(
      sessionFixture("agent:main:cron:daily-media:run:run-123", {
        sessionId: "cron-run-session",
        cronRunContinuation: {
          lifecycleRevision: "revision-1",
          phase: "ready",
          basePersisted: true,
        },
        updatedAt: 1,
      }),
    );

    await deliverGeneratedMedia({
      id: "session-delivery-cron-media",
      sessionKey: "agent:main:cron:daily-media:run:run-123",
      messageId: "image:cron-task:agent-loop",
      expectedMediaUrls: ["/tmp/proof.png"],
      suppressTextDelivery: true,
    });

    expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({
        sessionKey: "agent:main:cron:daily-media:run:run-123",
        sessionId: "cron-run-session",
      }),
      {
        allowSyntheticCronRunContinuation: true,
        expectFinal: true,
        forceSyntheticClient: true,
        internalDeliveryMediaUrls: ["/tmp/proof.png"],
        runtimeContextFragments: expectedGeneratedMediaContext,
        internalDeliverySuppressText: true,
        onAccepted: expect.any(Function),
      },
    );
  });

  it("defers a generated-media turn still owned by agent recovery", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "in_flight" });
    mocks.loadSessionEntry.mockReturnValue(
      sessionFixture("agent:main:main", {
        sessionId: "agent:main:main",
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: "image:task-owned:agent-loop",
        updatedAt: 1,
      }),
    );

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-owned",
        messageId: "image:task-owned:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("still owned by agent recovery");

    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media-owned",
      1_000,
      expectQueueContext(),
    );
  });

  it("retains the local fence when gateway dedupe reports another in-flight owner", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "in_flight" });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-in-flight",
        messageId: "image:task-in-flight:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("still owned by agent recovery");

    expect(mocks.markSessionDeliveryAttemptStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-delivery-media-in-flight" }),
      expectQueueContext(),
    );
    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media-in-flight",
      1_000,
      expectQueueContext(),
    );
  });

  it("fails closed when a terminal agent turn has no replayable result", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "ok" });
    mocks.loadSessionEntry.mockReturnValue(
      sessionFixture("agent:main:main", {
        sessionId: "agent:main:main",
        restartRecoveryTerminalRunIds: ["image:task-terminal:agent-loop"],
        updatedAt: 1,
      }),
    );

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-terminal",
        messageId: "image:task-terminal:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered without durable terminal evidence");
  });

  it("retries a captured empty terminal result instead of dead-lettering it", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "ok" });
    mocks.loadSessionEntry.mockReturnValue(
      sessionFixture("agent:main:main", {
        sessionId: "agent:main:main",
        restartRecoveryTerminalRunIds: ["image:task-terminal-empty:agent-loop"],
        restartRecoveryTerminalDeliveryEvidence: [
          { runId: "image:task-terminal-empty:agent-loop", captured: true },
        ],
        updatedAt: 1,
      }),
    );

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-terminal-empty",
        message: "generation completed",
        messageId: "image:task-terminal-empty:agent-loop",
        retryCount: 1,
        lastChargedAgentRunAttempt: 0,
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: [],
      }),
    ).rejects.toThrow("completed without a visible reply");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-terminal-empty",
      undefined,
      expectQueueContext(),
    );
    expect(mocks.failSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media-terminal-empty",
      1_000,
      expectQueueContext(),
    );
  });

  it("dead-letters an interrupted attempt without durable agent evidence", async () => {
    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-interrupted-unproven",
        messageId: "image:task-interrupted-unproven:agent-loop",
        deliveryStartedAt: 2,
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("interrupted unproven attempt");

    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });

  it("does not replay private terminal media as an owning-transcript delivery", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "ok" });
    mocks.loadSessionEntry.mockReturnValue(
      sessionFixture("agent:main:main", {
        sessionId: "agent:main:main",
        restartRecoveryTerminalRunIds: ["image:task-terminal-private:agent-loop"],
        restartRecoveryTerminalDeliveryEvidence: [
          {
            runId: "image:task-terminal-private:agent-loop",
            payloads: [{ visible: false, mediaUrls: ["/tmp/proof.png"] }],
          },
        ],
        updatedAt: 1,
      }),
    );

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-terminal-private",
        messageId: "image:task-terminal-private:agent-loop",
        route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("missed expected media");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-terminal-private",
      expect.objectContaining({ expectedMediaUrls: ["/tmp/proof.png"] }),
      expectQueueContext(),
    );
    expect(mocks.failSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media-terminal-private",
      expect.stringContaining("missed expected media"),
      expectQueueContext(),
    );
    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media-terminal-private",
      1_000,
      expectQueueContext(),
    );
  });

  it("persists internal generated audio as managed transcript content", async () => {
    const attachment = {
      type: "audio" as const,
      mediaUrl: "/tmp/proof.mp3",
      mimeType: "audio/mpeg",
    };
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: { payloads: [{ text: "ready", mediaUrls: [attachment.mediaUrl] }] },
    });

    await deliverGeneratedMedia({
      id: `session-delivery-media-internal-${attachment.type}`,
      messageId: `${attachment.type}:task-internal:agent-loop`,
      route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
      expectedMediaUrls: [attachment.mediaUrl],
      expectedMediaAttachments: {
        [attachment.mediaUrl]: {
          type: attachment.type,
          path: attachment.mediaUrl,
          mimeType: attachment.mimeType,
        },
      },
    });

    expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({ deliver: false, sourceReplyDeliveryMode: "automatic" }),
      expect.objectContaining({ internalDeliveryMediaUrls: [attachment.mediaUrl] }),
    );
    expect(mocks.createManagedOutgoingMediaBlocks).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      agentId: "main",
      items: [
        {
          url: attachment.mediaUrl,
          mimeType: attachment.mimeType,
          trustedLocal: true,
        },
      ],
      stateDir: fixture.testState.stateDir,
      localRoots: [fixture.testState.statePath("media")],
    });
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [],
        displayContent: [expect.objectContaining({ type: attachment.type })],
        idempotencyKey: `${attachment.type}:task-internal:agent-loop:generated-media-transcript`,
      }),
    );
    expect(mocks.attachManagedOutgoingMediaToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "generated-media-transcript" }),
    );
    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("replays targetless media into the original owner transcript without duplicating artifacts", async () => {
    const sessionId = "ops-global-session";
    const sourceRunId = "image:task-global:agent-loop";
    const transcriptRunId = "resumed-completion-run";
    const mediaPath = fixture.testState.statePath("media", "tool-image-generation", "proof.png");
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, createSolidPngBuffer(1, 1, { r: 24, g: 64, b: 128 }));
    const opsStorePath = fixture.testState.statePath("agents", "ops", "sessions", "sessions.json");
    const researchStorePath = fixture.testState.statePath(
      "agents",
      "research",
      "sessions",
      "sessions.json",
    );
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: "global", storePath: opsStorePath },
      { sessionId, updatedAt: 1 },
    );
    await upsertSessionEntryCore(
      { agentId: "research", sessionKey: "global", storePath: researchStorePath },
      { sessionId: "research-global-session", updatedAt: 1 },
    );
    const originalContent = [
      { type: "thinking", thinking: "Check the generated choices.", thinkingSignature: "signed" },
      {
        type: "text",
        text: `Here are your choices.\nMEDIA:${mediaPath}`,
        textSignature: "signed",
      },
    ];
    await appendTranscriptMessage(
      { agentId: "ops", sessionId, sessionKey: "global", storePath: opsStorePath },
      {
        eventId: "completion-reply",
        message: {
          role: "assistant",
          content: originalContent,
          stopReason: "stop",
          __openclaw: { runId: transcriptRunId },
        },
      },
    );
    const transcriptActual = await vi.importActual<
      typeof import("../config/sessions/transcript.js")
    >("../config/sessions/transcript.js");
    const transcriptPersistenceActual = await vi.importActual<
      typeof import("./server-methods/chat-transcript-persistence.js")
    >("./server-methods/chat-transcript-persistence.js");
    mocks.enrichAssistantTranscriptMediaForRun.mockImplementation(
      transcriptPersistenceActual.enrichAssistantTranscriptMediaForRun,
    );
    const managedMediaActual = await vi.importActual<
      typeof import("./managed-image-attachments.js")
    >("./managed-image-attachments.js");
    const queueStorageActual = await vi.importActual<
      typeof import("../infra/session-delivery-queue-storage.js")
    >("../infra/session-delivery-queue-storage.js");
    const { readManagedImageRecord } = await import("./managed-image-record-store.js");
    mocks.appendAssistantMessageToSessionTranscript
      .mockImplementationOnce(transcriptActual.appendAssistantMessageToSessionTranscript)
      .mockImplementationOnce(transcriptActual.appendAssistantMessageToSessionTranscript);
    mocks.createManagedOutgoingMediaBlocks.mockImplementation(
      managedMediaActual.createManagedOutgoingMediaBlocks,
    );
    mocks.attachManagedOutgoingMediaToMessage
      .mockImplementationOnce(() => {
        throw new Error("synthetic crash after transcript append");
      })
      .mockImplementationOnce(managedMediaActual.attachManagedOutgoingMediaToMessage);
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: "global", storePath: opsStorePath },
      {
        sessionId,
        updatedAt: 1,
        ...buildRestartRecoveryClaimCleanupPatch({
          entry: {
            sessionId,
            updatedAt: 1,
            restartRecoveryDeliverySourceRunId: sourceRunId,
            restartRecoveryDeliveryRunId: transcriptRunId,
          },
          recordTerminalSource: true,
          terminalRunId: transcriptRunId,
          terminalDeliveryEvidence: { payloads: [{ visible: true, mediaUrls: [mediaPath] }] },
        }),
      },
    );
    const storedEntry = loadStoredSessionEntry({
      agentId: "ops",
      sessionKey: "global",
      storePath: opsStorePath,
    });
    if (!storedEntry) {
      throw new Error("expected persisted media owner");
    }
    mocks.loadSessionEntry.mockReturnValue(
      sessionFixture("global", storedEntry, { agentId: "ops", storePath: opsStorePath }),
    );

    const queueId = await queueStorageActual.enqueueSessionDelivery(
      {
        kind: "agentTurn",
        sessionKey: "global",
        message: "generated image ready",
        messageId: "image:task-global:agent-loop",
        route: { channel: "webchat", to: "global", chatType: "direct" },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "internal",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "automatic",
        expectedMediaUrls: [mediaPath],
        expectedMediaAttachments: {
          [mediaPath]: {
            type: "image",
            path: mediaPath,
            name: "proof.png",
            mimeType: "image/png",
            sizeBytes: (await fs.stat(mediaPath)).size,
            width: 1,
            height: 1,
          },
        },
        idempotencyKey: "image:task-global:agent-loop",
      },
      fixture.queueContext,
    );
    const firstAttempt = await queueStorageActual.loadPendingSessionDelivery(
      queueId,
      fixture.queueContext,
    );
    if (!firstAttempt || firstAttempt.kind !== "agentTurn") {
      throw new Error("expected queued generated media attempt");
    }
    mocks.dispatchGatewayMethodInProcess.mockResolvedValue({
      status: "ok",
      result: { payloads: [{ text: "ready", mediaUrls: [mediaPath] }] },
    });

    await expect(deliverGeneratedMedia(firstAttempt, fixture.testState.stateDir)).rejects.toThrow(
      "synthetic crash after transcript append",
    );
    const replayAttempt = await queueStorageActual.loadPendingSessionDelivery(
      queueId,
      fixture.queueContext,
    );
    if (!replayAttempt || replayAttempt.kind !== "agentTurn") {
      throw new Error("expected prepared generated media replay");
    }
    const firstPreparedBlocks = replayAttempt.preparedMediaBlocks?.[mediaPath];
    expect(firstPreparedBlocks).toEqual([
      expect.objectContaining({ type: "image", artifactId: expect.any(String) }),
    ]);

    await deliverGeneratedMedia(replayAttempt, fixture.testState.stateDir);
    const afterReplay = await queueStorageActual.loadPendingSessionDelivery(
      queueId,
      fixture.queueContext,
    );
    expect(
      afterReplay?.kind === "agentTurn" ? afterReplay.preparedMediaBlocks?.[mediaPath] : null,
    ).toEqual(firstPreparedBlocks);
    expect(mocks.createManagedOutgoingMediaBlocks).toHaveBeenCalledTimes(1);

    const opsEvents = await loadTranscriptEvents({
      agentId: "ops",
      sessionId,
      sessionKey: "global",
      storePath: opsStorePath,
    });
    expect(opsEvents).toHaveLength(2);
    expect(opsEvents[0]).toMatchObject({ type: "session", id: sessionId });
    const messageEvent = opsEvents[1] as {
      id?: string;
      message?: {
        role?: string;
        content?: Array<Record<string, unknown>>;
        openclawDisplayContent?: Array<Record<string, unknown>>;
      };
    };
    expect(messageEvent.message).toMatchObject({
      role: "assistant",
      content: originalContent,
      openclawDisplayContent: [
        expect.objectContaining({ type: "thinking" }),
        { type: "text", text: "Here are your choices." },
        expect.objectContaining({ type: "image", artifactId: expect.any(String) }),
      ],
    });
    expect(messageEvent.id).toBe("completion-reply");
    expect(messageEvent.message?.openclawDisplayContent).not.toEqual([
      { type: "text", text: path.basename(mediaPath) },
    ]);
    const imageBlock = messageEvent.message?.openclawDisplayContent?.find(
      (block) => block.type === "image",
    );
    const artifactId = imageBlock?.artifactId;
    expect(artifactId).toBeTypeOf("string");
    const parsedArtifact = managedMediaActual.parseManagedOutgoingArtifactId(String(artifactId));
    expect(parsedArtifact).not.toBeNull();
    const record = await readManagedImageRecord(
      parsedArtifact?.attachmentId ?? "",
      fixture.testState.stateDir,
    );
    expect(record).toMatchObject({ messageId: messageEvent.id, sessionKey: "global" });
    await expect(
      managedMediaActual.resolveManagedOutgoingMediaArtifactDownload({
        sessionKey: "global",
        agentId: "ops",
        artifactId: String(artifactId),
        stateDir: fixture.testState.stateDir,
      }),
    ).resolves.toMatchObject({ artifactId, type: "image" });
    await expect(
      loadTranscriptEvents({
        agentId: "research",
        sessionId: "research-global-session",
        sessionKey: "global",
        storePath: researchStorePath,
      }),
    ).resolves.toEqual([]);
    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
    expect(mocks.failSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.deferSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.markSessionDeliverySettlement).not.toHaveBeenCalled();
    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });

  it("persists proven internal media before retrying the missing subset", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: { payloads: [{ text: "first ready", mediaUrls: ["/tmp/one.png"] }] },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-internal-partial",
        message: "generated images ready",
        messageId: "image:task-internal-partial:agent-loop",
        route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
        expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
        expectedMediaAttachments: {
          "/tmp/one.png": { type: "image", path: "/tmp/one.png", name: "one.png" },
          "/tmp/two.png": { type: "image", path: "/tmp/two.png", name: "two.png" },
        },
      }),
    ).rejects.toThrow("partially missed expected media: /tmp/two.png");

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        content: [],
        displayContent: [expect.objectContaining({ type: "image" })],
        storePath: "/tmp/sessions.json",
        idempotencyKey: "image:task-internal-partial:agent-loop:generated-media-transcript",
      }),
    );
    expect(mocks.createManagedOutgoingMediaBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          {
            url: "/tmp/one.png",
            filename: "one.png",
            trustedLocal: true,
          },
        ],
      }),
    );
    expect(mocks.mergeSessionDeliveryPreparedMediaBlocks).toHaveBeenCalledWith(
      "session-delivery-media-internal-partial",
      "/tmp/one.png",
      [expect.objectContaining({ type: "image" })],
      expectQueueContext(fixture.testState.stateDir),
    );
    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-internal-partial",
      expect.objectContaining({
        expectedMediaUrls: ["/tmp/two.png"],
        suppressTextDelivery: true,
      }),
      expectQueueContext(),
    );
  });

  it("does not count private reasoning media as an owning-transcript reply", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ isReasoning: true, mediaUrls: ["/tmp/proof.png"] }],
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-internal-reasoning",
        messageId: "image:task-internal-reasoning:agent-loop",
        route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("missed expected media: /tmp/proof.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-internal-reasoning",
      expect.objectContaining({ expectedMediaUrls: ["/tmp/proof.png"] }),
      expectQueueContext(),
    );
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.createManagedOutgoingMediaBlocks).not.toHaveBeenCalled();
  });

  it("accepts a suppressed visible automatic completion notice", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "generation failed" }],
        deliveryStatus: { status: "suppressed" },
      },
    });

    await deliverGeneratedMedia({
      id: "session-delivery-notice-suppressed",
      message: "generation failed",
      messageId: "image:task-notice-suppressed:agent-loop",
      expectedMediaUrls: [],
    });

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("checks partial automatic evidence only for media still missing", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/one.png"] }, { mediaUrls: ["/tmp/two.png"] }],
        deliveryStatus: {
          status: "partial_failed",
          errorMessage: "second attachment failed before send",
          payloadOutcomes: [
            { index: 0, status: "sent" },
            { index: 1, status: "failed", sentBeforeError: false },
          ],
        },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-cross-path-partial",
        message: "generated images ready",
        messageId: "image:task-cross-path-partial:agent-loop",
        expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
      }),
    ).rejects.toThrow("missed expected media: /tmp/two.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-cross-path-partial",
      expect.objectContaining({
        expectedMediaUrls: ["/tmp/two.png"],
        message: expect.stringContaining("MEDIA:/tmp/two.png"),
        suppressTextDelivery: true,
      }),
      expectQueueContext(),
    );
    expect(mocks.advanceSessionDeliveryAgentRun.mock.calls[0]?.[1]?.message).not.toContain(
      "/tmp/one.png",
    );
  });

  it("dead-letters a partial send without exact per-payload evidence", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: {
          status: "partial_failed",
          errorMessage: "transport failed after an unknown side effect",
        },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-partial-unclassified",
        messageId: "image:task-partial-unclassified:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered after ambiguous side effects");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("dead-letters truncated terminal evidence before retrying missing media", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "earlier payload" }],
        payloadsTruncated: true,
        deliveryStatus: { status: "sent" },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-truncated",
        messageId: "image:task-truncated:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered after truncated evidence");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("dead-letters a partial visible send instead of replaying it", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/one.png", "/tmp/two.png"] }],
        deliveryStatus: {
          status: "partial_failed",
          errorMessage: "second attachment failed after first send",
          payloadOutcomes: [{ index: 0, status: "failed", sentBeforeError: true }],
        },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-partial",
        message: "generated images ready",
        messageId: "image:task-partial:agent-loop",
        expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
      }),
    ).rejects.toThrow("dead-lettered after ambiguous side effects");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("dead-letters impossible truncated messaging-tool evidence", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "channel:wrong",
            mediaUrls: ["/tmp/proof.png"],
          },
        ],
        messagingToolSentTargetsTruncated: true,
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-tool-targets-truncated",
        messageId: "image:task-tool-targets-truncated:agent-loop",
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: "aggregate-only message-tool delivery",
      result: { didSendViaMessagingTool: true, messagingToolSentMediaUrls: ["/tmp/proof.png"] },
    },
    {
      kind: "committed cron action",
      result: { payloads: [{ text: "ready" }], successfulCronAdds: 1 },
    },
  ])("dead-letters $kind before a fresh attempt", async ({ result }) => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "ok", result });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-unsafe-side-effect",
        messageId: "image:task-unsafe-side-effect:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });
});
