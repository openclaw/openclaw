import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { claimEmbeddedPendingUserInputAnswer } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import {
  cancelPendingAgentQuestionForSession,
  runAgentHarnessGatewayQuestion,
} from "../../agents/harness/gateway-question.js";
import { withQuestionGateway } from "../../agents/harness/gateway-question.test-support.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { withQuestionCreator } from "./reply-run-question.test-support.js";
import { beginReplyMessageInjectionTarget, replyRunRegistry } from "./reply-run-registry.js";

it("leaves hidden-run image input for visible followup when question registration fails", async () => {
  const key = "agent:main:failed-hidden-question-registration";
  const run = createQueueTestRun({ prompt: "Use this image", messageId: "registration-image" });
  await withQuestionGateway(async (fixture) =>
    withQuestionCreator(key, run, async (operation, fingerprint) => {
      const hello = fixture.holdNextHello();
      const question = runAgentHarnessGatewayQuestion({
        questionId: "ask_hidden_registration_failure",
        sessionKey: key,
        questions: [{ id: "answer", header: "Answer", question: "Continue?", isOther: true }],
        timeoutMs: 60_000,
        signal: fixture.backingRun.signal,
        delivery: { onBlockReply: vi.fn() },
      });
      const questionOutcome = question.then(
        (result) => ({ kind: "answer" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
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
            claimEmbeddedPendingUserInputAnswer(text, options, key, undefined, {
              kind,
              assertCurrent,
            }),
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
          Promise.race([
            hello.entered,
            questionOutcome.then(() => {
              throw new Error("question completed before the registration handshake");
            }),
          ]),
          5_000,
          "question did not begin Gateway registration",
        );
        const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(key);
        expect(target).toBeDefined();
        const attempt = beginReplyMessageInjectionTarget(target!, run.prompt, {
          isInboundUserMessage: true,
          toolAuthorityFingerprint: fingerprint,
          images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          assertCurrent: () => operation.abortSignal.throwIfAborted(),
        });
        imageOutcome = attempt.outcome.then(
          (outcome) => ({ kind: "outcome", outcome }),
          (error: unknown) => ({ kind: "error", error }),
        );
        await withTestTimeout(enteredCancel.promise, 1_000, "image did not reach question owner");
        expect(fixture.requests.some((frame) => frame.method === "question.request")).toBe(false);
        hello.fail();
        await expect(attempt.acceptance).resolves.toBe(false);
        await expect(imageOutcome).resolves.toMatchObject({
          kind: "outcome",
          outcome: { status: "rejected", reason: "input_visibility_mismatch" },
        });
        await expect(questionOutcome).resolves.toMatchObject({ kind: "error" });
        expect(
          fixture.requests.filter(
            (frame) =>
              frame.method === "question.resolve" &&
              isRecord(frame.params) &&
              frame.params.resolvedBy === "image-reply",
          ),
        ).toEqual([]);
        expect(queueMessage).not.toHaveBeenCalled();
        expect(cancelBackingRun).not.toHaveBeenCalled();
        expect(operation.phase).toBe("running");
        expect(fixture.backingRun.signal.aborted).toBe(false);
      } finally {
        hello.release();
        fixture.backingRun.abort();
        await Promise.allSettled([questionOutcome, imageOutcome]);
        clearAgentRunContext("accepted-backing-work");
      }
    }),
  );
});
