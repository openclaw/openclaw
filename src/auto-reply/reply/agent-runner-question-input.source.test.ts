import { expect, it, vi } from "vitest";
import { runAgentHarnessGatewayQuestion } from "../../agents/harness/gateway-question.js";
import { createAskUserTool } from "../../agents/tools/ask-user-tool.js";
import { isEmbeddedMode, setEmbeddedMode } from "../../infra/embedded-mode.js";
import {
  EmbeddedQuestionBroker,
  setEmbeddedQuestionBroker,
  clearEmbeddedQuestionBroker,
} from "../../infra/embedded-question-broker.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { SourceQuestionV1 } from "../source-question.types.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { withQuestionCreator } from "./reply-run-question.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

it("admits only the original source question through the real caller policy and confirms native ask_user", async () => {
  const broker = new EmbeddedQuestionBroker(createTestGatewayScheduler());
  const priorMode = isEmbeddedMode();
  setEmbeddedMode(true);
  setEmbeddedQuestionBroker(broker);
  const key = "agent:main:whatsapp:direct:source-answer";
  let question: SourceQuestionV1 | undefined;
  const run = createQueueTestRun(
    {
      prompt: "How many seats?",
      runObservers: {
        sourceQuestionInput: {
          version: 1,
          mode: "new-task",
          onQuestion: async (value) => {
            question = value;
          },
        },
      },
    },
    {
      messageProvider: "whatsapp",
      senderId: "+1000",
      agentAccountId: "default",
      chatType: "direct",
    },
  );
  try {
    await withQuestionCreator(key, run, async () => {
      const controller = new AbortController();
      const tool = createAskUserTool({ sessionKey: key, runId: "source-ask" });
      const pending = tool.execute(
        "source-ask",
        {
          questions: [
            {
              id: "seats",
              header: "Seats",
              question: "How many seats?",
              options: [{ label: "100" }, { label: "200" }],
            },
          ],
          timeoutSeconds: 60,
        },
        controller.signal,
      );
      const result = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.waitFor(() => expect(question).toBeDefined());
        if (!question) {
          throw new Error("Source publication missing");
        }
        const answer = async (target: SourceQuestionV1, toolsAllow?: string[]) => {
          const receipt = vi.fn();
          expect(
            await runReplyQuestionInput({
              commandBody: "100",
              sessionKey: key,
              followupRun: { ...run, toolsAllow },
              sessionCtx: buildTestCtx({
                SenderId: "+1000",
                AccountId: "default",
                SessionKey: key,
              }),
              opts: {
                sourceQuestionInput: {
                  version: 1,
                  mode: "answer-only",
                  question: target,
                  onReceipt: receipt,
                },
              },
            }),
          ).toEqual({ handled: true, payload: undefined });
          expect(receipt).toHaveBeenCalledOnce();
          return receipt.mock.calls[0]![0];
        };
        expect(await answer({ ...question })).toMatchObject({ status: "refused" });
        expect(await answer(question, [])).toMatchObject({ status: "refused" });
        expect(question.signal.aborted).toBe(false);
        expect(await answer(question)).toMatchObject({
          status: "confirmed",
          resolutionId: expect.any(String),
        });
        expect(await result).toHaveProperty("value");
        expect(question.signal.aborted).toBe(true);
        expect(await answer(question)).toEqual({ status: "refused", reason: "stale-question" });
      } finally {
        controller.abort();
        await result;
      }
    });
  } finally {
    broker.stop();
    clearEmbeddedQuestionBroker(broker);
    setEmbeddedMode(priorMode);
  }
});

it.each([false, true])(
  "lets the original native owner validate explicit empty answers (allowEmpty: %s)",
  async (allowEmpty) => {
    const broker = new EmbeddedQuestionBroker(createTestGatewayScheduler());
    const priorMode = isEmbeddedMode();
    setEmbeddedMode(true);
    setEmbeddedQuestionBroker(broker);
    const sessionKey = "agent:main:whatsapp:direct:empty-source";
    let question: SourceQuestionV1 | undefined;
    const run = createQueueTestRun(
      {
        prompt: "Optional note",
        runObservers: {
          sourceQuestionInput: {
            version: 1,
            mode: "new-task",
            onQuestion: async (value) => {
              question = value;
            },
          },
        },
      },
      {
        messageProvider: "whatsapp",
        senderId: "+1000",
        agentAccountId: "default",
        chatType: "direct",
      },
    );
    try {
      await withQuestionCreator(sessionKey, run, async () => {
        const stop = new AbortController();
        let resumed = false;
        const native = runAgentHarnessGatewayQuestion({
          questionId: "ask_99999999999999999999999999999999",
          sessionKey,
          questions: [
            {
              id: "note",
              header: "Note",
              question: "Any note?",
              options: [],
              isOther: true,
              allowEmpty,
            },
          ],
          timeoutMs: 60_000,
          signal: stop.signal,
          delivery: {},
        });
        const finished = native.then(
          (value) => {
            resumed = true;
            return value;
          },
          () => undefined,
        );
        try {
          await vi.waitFor(() => expect(question).toBeDefined());
          const receipt = vi.fn();
          expect(
            await runReplyQuestionInput({
              sessionKey,
              commandBody: "",
              followupRun: run,
              sessionCtx: buildTestCtx({
                SessionKey: sessionKey,
                SenderId: "+1000",
                AccountId: "default",
              }),
              opts: {
                sourceQuestionInput: {
                  version: 1,
                  mode: "answer-only",
                  question: question!,
                  onReceipt: receipt,
                },
              },
            }),
          ).toEqual({ handled: true, payload: undefined });
          expect(receipt).toHaveBeenCalledExactlyOnceWith(
            allowEmpty
              ? { status: "confirmed", resolutionId: expect.any(String) }
              : { status: "refused", reason: "invalid-answer" },
          );
          if (allowEmpty) {
            expect(await finished).toMatchObject({
              status: "answered",
              answers: { answers: { note: [] } },
            });
          } else {
            expect(resumed).toBe(false);
            expect(question!.signal.aborted).toBe(false);
          }
        } finally {
          stop.abort();
          await finished;
        }
      });
    } finally {
      broker.stop();
      clearEmbeddedQuestionBroker(broker);
      setEmbeddedMode(priorMode);
    }
  },
);
