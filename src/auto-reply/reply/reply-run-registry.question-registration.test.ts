import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withTestTimeout,
} from "../../../test/helpers/promise.js";
import { claimEmbeddedPendingUserInputAnswer as claimAnswer } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import {
  cancelPendingAgentQuestionForSession,
  runAgentHarnessGatewayQuestion,
} from "../../agents/harness/gateway-question.js";
import { withQuestionGateway } from "../../agents/harness/gateway-question.test-support.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { beginReplyMessageInjectionTarget } from "../../sessions/session-controller.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { withQuestionCreator } from "./reply-run-question.test-support.js";

it("leaves hidden-run image input for visible followup when question registration fails", async () => {
  const key = "agent:main:failed-hidden-question-registration";
  const run = createQueueTestRun({ prompt: "Use this image", messageId: "registration-image" });
  await withQuestionGateway(async (fixture) =>
    withQuestionCreator(key, run, async (operation, fingerprint) => {
      const hello = fixture.holdNextHello();
      const questionOutcome = Promise.allSettled([
        runAgentHarnessGatewayQuestion({
          questionId: "ask_hidden_registration_failure",
          sessionKey: key,
          questions: [{ id: "answer", header: "Answer", question: "Continue?", isOther: true }],
          timeoutMs: 60_000,
          signal: fixture.backingRun.signal,
          delivery: { onBlockReply: vi.fn() },
        }),
      ]);
      const enteredCancel = createDeferred();
      const queueMessage = vi.fn(async () => {});
      const cancelBackingRun = vi.fn();
      operation.attachBackend({
        kind: "embedded",
        runId: "accepted-backing-work",
        toolAuthorityFingerprint: fingerprint,
        cancel: cancelBackingRun,
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage,
          claimPendingUserInputAnswer: (text, options, assertCurrent, kind) =>
            claimAnswer(text, options, key, undefined, { kind, assertCurrent }),
          cancelPendingUserInput: (resolvedBy, assertCurrent, kind) => {
            enteredCancel.resolve();
            return cancelPendingAgentQuestionForSession({
              sessionKey: key,
              resolvedBy,
              authority: { kind, assertCurrent },
            });
          },
        },
      });
      operation.setPhase("running");
      registerAgentRunContext("accepted-backing-work", {
        isControlUiVisible: false,
        projectSessionMessages: false,
      });
      let imageOutcome: Promise<unknown> | undefined;
      try {
        await withTestTimeout(
          awaitGateBeforeSettlement(
            hello.entered,
            questionOutcome,
            "question completed before the registration handshake",
          ),
          5_000,
          "question did not begin Gateway registration",
        );
        const target = captureCurrentReplyMessageInjectionTarget(key);
        expect(target).toBeDefined();
        const attempt = await beginReplyMessageInjectionTarget(target!, run.prompt, {
          isInboundUserMessage: true,
          toolAuthorityFingerprint: fingerprint,
          images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          assertCurrent: () => operation.abortSignal.throwIfAborted(),
        });
        imageOutcome = Promise.allSettled([attempt.outcome]);
        await withTestTimeout(enteredCancel.promise, 1_000, "image did not reach question owner");
        expect(fixture.requests.some((frame) => frame.method === "question.request")).toBe(false);
        hello.fail();
        await expect(attempt.acceptance).resolves.toBe(false);
        await expect(imageOutcome).resolves.toMatchObject([
          {
            status: "fulfilled",
            value: { status: "rejected", reason: "input_visibility_mismatch" },
          },
        ]);
        await expect(questionOutcome).resolves.toMatchObject([{ status: "rejected" }]);
        const resolvedBy = fixture.requests
          .filter((frame) => frame.method === "question.resolve")
          .map((frame) => (isRecord(frame.params) ? frame.params.resolvedBy : undefined));
        expect(resolvedBy).not.toContain("image-reply");
        expect(queueMessage).not.toHaveBeenCalled();
        expect(cancelBackingRun).not.toHaveBeenCalled();
        expect({ phase: operation.phase, aborted: fixture.backingRun.signal.aborted }).toEqual({
          phase: "running",
          aborted: false,
        });
      } finally {
        hello.release();
        fixture.backingRun.abort();
        await Promise.allSettled([questionOutcome, imageOutcome]);
        clearAgentRunContext("accepted-backing-work");
      }
    }),
  );
});
