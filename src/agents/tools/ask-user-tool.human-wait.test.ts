import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeAgentRunHumanWait } from "../agent-run-approval-wait.js";
import { createAskUserTool } from "./ask-user-tool.js";

type GatewayCall = Extract<
  NonNullable<Parameters<typeof createAskUserTool>[0]["gatewayCall"]>,
  (...args: never[]) => unknown
>;

const args = {
  questions: [
    {
      id: "choice",
      header: "Choice",
      question: "Select one",
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
};

describe("ask_user human wait liveness events", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes only after prompt answerability and requires execution to resume", async ({
    signal,
  }) => {
    const runId = "run-ask-user-human-wait";
    const sessionKey = "agent:main:discord:channel:ask-user-human-wait";
    const answerStarted = createDeferred();
    const promptDelivered = createDeferred();
    const waitStarted = createDeferred();
    let finishAnswer: ((value: unknown) => void) | undefined;
    const gatewayCall = (async (
      method: string,
      _opts: Record<string, unknown>,
      params: Record<string, unknown>,
    ) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        answerStarted.resolve();
        return await new Promise((resolve) => {
          finishAnswer = resolve;
        });
      }
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      throw new Error("unexpected Gateway question method");
    }) as GatewayCall;
    const wait = observeAgentRunHumanWait({ runId, sessionKey });
    wait.onChange = (snapshot) => {
      if (snapshot.waiting) {
        waitStarted.resolve();
      }
    };
    const pending = createAskUserTool({
      runId,
      sessionKey,
      gatewayCall,
      questionPrompt: { send: () => promptDelivered.resolve() },
    }).execute("call-ask-user-wait", args);
    try {
      await withinTest(
        awaitGateBeforeSettlement(answerStarted.promise, pending, "answer RPC did not start"),
        signal,
      );
      await withinTest(
        awaitGateBeforeSettlement(promptDelivered.promise, pending, "prompt did not deliver"),
        signal,
      );
      await withinTest(
        awaitGateBeforeSettlement(
          waitStarted.promise,
          pending,
          "answerable wait event was not emitted",
        ),
        signal,
      );
      expect(wait.waiting).toBe(true);
      expect(wait.resumeRequired).toBe(false);

      finishAnswer?.({ status: "answered", answers: { answers: { choice: ["A"] } } });
      await expect(pending).resolves.toMatchObject({ details: { status: "answered" } });
      expect(wait.waiting).toBe(false);
      expect(wait.resumeRequired).toBe(true);
      wait.markExecutionResumed();
      expect(wait.waiting).toBe(false);
      expect(wait.resumeRequired).toBe(false);
    } finally {
      finishAnswer?.({ status: "cancelled" });
      wait.dispose();
    }
  });
});
