import path from "node:path";
import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  createReplyOperation,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.entry.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChatSendMessageInjectionStarter } from "./chat-send-message-injection.js";

it.each(
  (["compatible", "restricted", "different profile"] as const).flatMap((caller) =>
    [false, true].map((image) => ({ caller, image })),
  ),
)(
  "projects Gateway caller authority before hidden question settlement (caller=$caller, image=$image)",
  async ({ caller, image }) => {
    const compatible = caller === "compatible";
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:gateway-hidden-question";
      const sessionId = "gateway-hidden-question-session";
      const runId = "gateway-hidden-question-owner";
      const text = "Green";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      const owner = createQueueTestRun({ prompt: "child coordination" });
      owner.run = {
        ...owner.run,
        agentId: "main",
        agentDir: state.agentDir(),
        sessionKey,
        sessionId,
        workspaceDir: state.workspaceDir,
        permissionMode: "full",
        senderIsOwner: true,
        messageProvider: "webchat",
        traceAuthorized: true,
        clientCaps: ["tool-events"],
        approvalReviewerDeviceId: "browser-device",
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "sessions_send",
          sourceRole: "subagent",
          sourceSessionKey: "agent:main:subagent:worker",
        },
      };
      const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      owner.operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "question-owner",
        scopes: ["operator.admin"],
        gatewayAccessGrant: null,
        modelPolicy: prepareOperatorModelPolicy({ cfg: {}, policy: {} }),
        assertCurrent: () => operation.abortSignal.throwIfAborted(),
      });
      const incomingAuthority =
        caller === "different profile"
          ? createAdmittedRunOperatorAuthority({
              ...owner.operatorAuthority,
              profileId: "question-participant",
            })
          : owner.operatorAuthority;
      await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(owner));
      const fingerprint = await operation.bindToolAuthorityRouteAsync({
        provider: owner.run.provider,
        model: owner.run.model,
      });
      const queueMessage = vi.fn(async () => {});
      const claim = vi.fn<
        NonNullable<ReplyBackendMessageInjectionV2["claimPendingUserInputAnswer"]>
      >(async (_text, options, assertCurrent, authorityKind) => {
        expect(options?.toolAuthorityFingerprint).toBe(fingerprint);
        expect(options).not.toHaveProperty("toolAuthorityOverlay");
        expect(authorityKind).toBe("source-bound");
        assertCurrent();
        return true;
      });
      const cancel = vi.fn<NonNullable<ReplyBackendMessageInjectionV2["cancelPendingUserInput"]>>(
        async (_resolvedBy, assertCurrent, authorityKind) => {
          expect(authorityKind).toBe("source-bound");
          assertCurrent();
          return true;
        },
      );
      operation.attachBackend({
        kind: "embedded",
        runId,
        toolAuthorityFingerprint: fingerprint,
        cancel: vi.fn(),
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage,
          claimPendingUserInputAnswer: claim,
          cancelPendingUserInput: cancel,
        },
      });
      operation.setPhase("running");
      registerAgentRunContext(runId, { isControlUiVisible: false, projectSessionMessages: false });
      try {
        const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey);
        expect(target).toBeDefined();
        const start = createChatSendMessageInjectionStarter({
          target,
          abortSignal: operation.abortSignal,
          operatorAuthority: incomingAuthority,
          assertCurrent: () => operation.abortSignal.throwIfAborted(),
          request: {
            p: { sessionKey, message: text, idempotencyKey: "gateway-question-answer" },
            rawMessage: text,
            supportsTaskSuggestions: false,
          },
          session: {
            agentId: "main",
            cfg: {},
            entry: undefined,
            sessionKey,
            storePath,
            clientRunId: "answer-run",
          },
          admittedSessionSettings: { permissionMode: caller === "restricted" ? "guarded" : "full" },
          turn: {
            ctx: {
              Provider: "webchat",
              SessionKey: sessionKey,
              Body: text,
              GatewayClientScopes: ["operator.admin"],
              GatewayClientCaps: ["tool-events"],
              ApprovalReviewerDeviceId: "browser-device",
            },
            isInternalTextSlashCommandTurn: false,
            replyOptionImages: image
              ? [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png", sourceIndex: 0 }]
              : [],
            replyOptionMedia: [],
          },
          imageOrder: [],
          userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
            input: { text },
            target: createTestUserTurnTranscriptTarget({ sessionKey, sessionId, storePath }),
          }),
          logGateway: createSubsystemLogger("gateway/question-test"),
        });
        const attempt = await start();
        expect(attempt).toBeDefined();
        await expect(attempt!.outcome).resolves.toMatchObject(
          compatible && !image
            ? { status: "accepted" }
            : { status: "rejected", reason: "input_visibility_mismatch" },
        );
        expect(claim).toHaveBeenCalledTimes(compatible && !image ? 1 : 0);
        expect(cancel).toHaveBeenCalledTimes(compatible && image ? 1 : 0);
        expect(queueMessage).not.toHaveBeenCalled();
      } finally {
        clearAgentRunContext(runId);
        operation.complete();
      }
    });
  },
);
