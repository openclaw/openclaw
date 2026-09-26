import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createChatSendMessageInjectionStarter } from "../../gateway/server-methods/chat-send-message-injection.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createFollowupTurnTestTypingController as createTypingController,
  createFollowupTurnTestTurn as createTurn,
  executeFollowupTurnForTest as executeFollowupTurn,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import {
  collectRuntimeMetadata,
  createOverflowSummaryRetrySource,
} from "./queue/delivery-context.js";
import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";

const state = getFollowupTurnTestState();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(resetFollowupTurnTestState);

describe("queued turn steering", () => {
  it.each(["gateway", "retained", "collected", "overflow"] as const)(
    "accepts successive Gateway steers into a %s followup after an older source completed",
    async (source) => {
      const root = tempDirs.make("openclaw-followup-steering-");
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:queued-steering";
      const entry: SessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        status: "running",
        restartRecoveryTerminalRunIds: ["previous-input"],
      };
      await replaceSessionEntry({ storePath, sessionKey }, entry);
      const operation = createReplyOperation({
        sessionKey,
        sessionId: entry.sessionId,
        turnKind: "queued_followup",
        resetTriggered: false,
      });
      const turn = createTurn({
        operation,
        session: {
          kind: "session",
          key: sessionKey,
          storePath,
          current: () => entry,
          publish: () => {},
          adopt: () => {},
        },
      });
      turn.queued.messageId = "queued-human-input";
      turn.queued.originatingChannel = "webchat";
      turn.queued.originatingTo = "dashboard";
      turn.queued.originatingThreadId = undefined;
      turn.queued.originatingAccountId = undefined;
      turn.queued.originatingChatType = "direct";
      turn.queued.media = undefined;
      turn.queued.run = {
        ...turn.queued.run,
        agentId: "main",
        agentDir: root,
        sessionKey,
        sessionFile: sessionKey,
        workspaceDir: root,
        messageProvider: "webchat",
        chatType: "direct",
        senderIsOwner: false,
      };
      const sourceTurnId = source === "gateway" ? "queued-human-input" : "original-queued-input";
      if (source !== "gateway") {
        turn.queued.sourceTurnId = sourceTurnId;
      }
      if (source === "collected") {
        turn.queued = {
          ...turn.queued,
          ...collectRuntimeMetadata([
            { ...turn.queued, sourceTurnId: "earlier-collected-input" },
            turn.queued,
          ]),
        };
      } else if (source === "overflow") {
        turn.queued = createOverflowSummaryRetrySource(turn.queued);
      }
      const steeringMessages = [
        "Use the revised request",
        "Keep the new scope",
        "Finish this first",
      ];
      const queueMessage = vi.fn(async (_text: string) => {});
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        expect(readChannelSourceTurnId(params.sessionCtx)).toBe(sourceTurnId);
        operation.bindToolAuthorityRoute({ provider: "anthropic", model: "claude" });
        operation.attachBackend({
          kind: "embedded",
          runId: "followup-execution",
          cancel: vi.fn(),
          messageInjection: { isAvailable: () => true, queueMessage },
        });
        for (const [index, message] of steeringMessages.entries()) {
          const clientRunId = `new-human-input-${index}`;
          const attempt = createChatSendMessageInjectionStarter({
            target: replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey),
            abortSignal: new AbortController().signal,
            request: {
              p: {
                sessionKey,
                message,
                idempotencyKey: clientRunId,
              },
              rawMessage: message,
              supportsTaskSuggestions: false,
            },
            session: {
              cfg: {},
              entry,
              sessionKey,
              storePath,
              clientRunId,
            },
            turn: {
              ctx: {
                Provider: "webchat",
                Surface: "webchat",
                OriginatingChannel: "webchat",
                OriginatingTo: "dashboard",
                To: "dashboard",
                SessionKey: sessionKey,
                ChatType: "direct",
                SenderId: "user-1",
                Body: message,
              },
              isInternalTextSlashCommandTurn: false,
              replyOptionImages: [],
              replyOptionMedia: [],
            },
            imageOrder: [],
            userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
              target: () => undefined,
            }),
            logGateway: createSubsystemLogger("gateway"),
          })();
          expect(
            attempt,
            "the active followup must retain its admitted source identity",
          ).toBeDefined();
          await expect(attempt!.outcome).resolves.toMatchObject({ status: "accepted" });
        }
        expect(queueMessage.mock.calls.map(([text]) => text)).toEqual(steeringMessages);
        expect(replyRunRegistry.getSourceTurnId(sessionKey)).toBe(sourceTurnId);
        return {
          runId: "followup-execution",
          outcome: { kind: "rejected", payload: { text: "done" } },
        };
      });
      try {
        await executeFollowupTurn({
          turn,
          defaults: {
            typing: createTypingController(),
            typingMode: "never",
            defaultModel: "claude",
          },
          onToolResult: vi.fn(async () => {}),
          onCompactionNoticePayload: vi.fn(async () => {}),
        });
      } finally {
        operation.complete();
      }
    },
  );

  it("accepts same-authority steering while a queued turn runs and rejects changed authority", async () => {
    const operation = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      turnKind: "queued_followup",
      resetTriggered: false,
    });
    const turn = createTurn({ operation });
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.read", "operator.write"],
      gatewayAccessGrant: null,
      source: {},
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    turn.queued.operatorAuthority = operatorAuthority;
    const queueMessage = vi.fn(async () => {});
    state.execute.mockImplementation(async () => {
      operation.bindToolAuthorityRoute({ provider: "anthropic", model: "claude" });
      operation.attachBackend({ kind: "embedded", cancel: vi.fn(), queueMessage });
      expect(operation.phase).toBe("running");
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget("main");
      expect(target).toBeDefined();
      const overlay = {
        operatorAuthority: createAdmittedRunOperatorAuthority({
          ...operatorAuthority,
          scopes: ["operator.write", "operator.read"],
          source: {},
          signal: new AbortController().signal,
        }),
        originatingChannel: turn.queued.originatingChannel,
        messageProvider: turn.queued.run.messageProvider,
        senderId: "user-2",
        senderIsOwner: false,
        disableTools: false,
        traceAuthorized: false,
      };
      await expect(
        beginReplyMessageInjectionTarget(target!, "Use the revised request", {
          isInboundUserMessage: true,
          toolAuthorityOverlay: overlay,
        }).outcome,
      ).resolves.toMatchObject({ status: "accepted" });
      await expect(
        beginReplyMessageInjectionTarget(target!, "Change tool permissions", {
          isInboundUserMessage: true,
          toolAuthorityOverlay: { ...overlay, disableTools: true },
        }).outcome,
      ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
      for (const incomingOperator of [
        undefined,
        createAdmittedRunOperatorAuthority({ ...operatorAuthority, profileId: "maintainer" }),
        createAdmittedRunOperatorAuthority({ ...operatorAuthority, scopes: ["operator.admin"] }),
      ]) {
        await expect(
          beginReplyMessageInjectionTarget(target!, "Different original operator authority", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: { ...overlay, operatorAuthority: incomingOperator },
          }).outcome,
        ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
      }
      expect(queueMessage).toHaveBeenCalledOnce();
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    try {
      await executeFollowupTurn({
        turn,
        defaults: { typing: createTypingController(), typingMode: "never", defaultModel: "claude" },
        onToolResult: vi.fn(async () => {}),
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
    } finally {
      operation.complete();
    }
  });
});
