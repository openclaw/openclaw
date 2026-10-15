import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import { SESSIONS_YIELD_ABORT_REASON } from "../embedded-agent-runner/run/attempt-sessions-yield.js";
import { gatewayStub, validArgs } from "./ask-user-tool.gateway.test-fixture.js";
import { createAskUserTool } from "./ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./ask-user-tool.test-support.js";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";

afterEach(resetPendingAskUserQuestionsForTest);

describe("native durable ask_user handoff", () => {
  it("cancels a transient question when a sibling hands off the run", async () => {
    const runAbort = new AbortController();
    const answer = createDeferred<{ status: "cancelled" }>();
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return answer.promise;
      }
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      throw new Error(`Unexpected question operation: ${method}`);
    });
    const question = wrapToolWithAbortSignal(
      createAskUserTool({ gatewayCall: gateway.call }),
      runAbort.signal,
    );
    const execution = question.execute("transient-sibling", validArgs);
    let outcome: unknown;
    const observed = execution.then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    try {
      await gateway.waitForCall("question.waitAnswer", execution);
      const sibling = wrapToolWithAbortSignal(
        createSessionsYieldTool({
          sessionId: "transient-sibling",
          claimYield: () => true,
          onYield: () => {
            runAbort.abort(SESSIONS_YIELD_ABORT_REASON);
          },
        }),
        runAbort.signal,
      );
      expect(await sibling.execute("yield-sibling", {})).toMatchObject({
        details: { status: "yielded" },
      });
      // The held transport has not settled; run cancellation must settle its wrapper.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(outcome).toMatchObject({ name: "AbortError" });
    } finally {
      answer.resolve({ status: "cancelled" });
      await observed;
    }
  });
  it.each(["legacy-void", "explicit-true"])(
    "commits registration and delivers the %s prompt before yielding without a live answer waiter",
    async (outcome) => {
      const delivered = createDeferred();
      const yielded = vi.fn();
      const gateway = gatewayStub(async (method, _opts, params) => {
        if (method === "question.request") {
          return { id: params.id, durable: true };
        }
        throw new Error(`Unexpected live waiter: ${method}`);
      });
      const send = vi.fn(async () => {
        await delivered.promise;
        return outcome === "explicit-true" ? true : undefined;
      });
      const tool = createAskUserTool({
        sessionKey: "agent:main:durable",
        runId: "asking",
        agentId: "main",
        gatewayCall: gateway.call,
        questionPrompt: { send },
        nativeQuestionHandoff: yielded,
      });
      const result = tool.execute("durable-call", validArgs);
      await gateway.waitForCall("question.request", result);
      expect(gateway.mock.mock.calls[0]?.[2].durable).toBe(true);
      expect(yielded).not.toHaveBeenCalled();
      delivered.resolve();
      await result;
      expect(send).toHaveBeenCalledOnce();
      expect(yielded).toHaveBeenCalledOnce();
      expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual(["question.request"]);
    },
  );

  it.each(["answered", "cancelled", "expired"])(
    "hands off a terminal %s registration retry without redelivering a prompt",
    async (status) => {
      const yielded = vi.fn();
      const send = vi.fn();
      const gateway = gatewayStub(async (method, _opts, params) => {
        if (method === "question.request") {
          return { id: params.id, durable: true, status };
        }
        throw new Error(`Unexpected terminal waiter: ${method}`);
      });
      const tool = createAskUserTool({
        sessionKey: `agent:main:terminal-${status}`,
        runId: "asking",
        agentId: "main",
        gatewayCall: gateway.call,
        questionPrompt: { send },
        nativeQuestionHandoff: yielded,
      });
      await tool.execute(`terminal-${status}`, validArgs);
      expect(send).not.toHaveBeenCalled();
      expect(yielded).toHaveBeenCalledOnce();
      expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual(["question.request"]);
    },
  );

  it.each(["failed", "suppressed"])(
    "hands off a committed question even when prompt delivery is %s",
    async (outcome) => {
      const yielded = vi.fn();
      const gateway = gatewayStub(async (method, _opts, params) => {
        if (method === "question.request") {
          return { id: params.id, durable: true };
        }
        if (method === "question.resolve") {
          return { status: "cancelled" };
        }
        throw new Error(`Unexpected live waiter: ${method}`);
      });
      const tool = createAskUserTool({
        sessionKey: "agent:main:delivery-failure",
        runId: "asking",
        agentId: "main",
        gatewayCall: gateway.call,
        nativeQuestionHandoff: yielded,
        questionPrompt: {
          send: async () => {
            if (outcome === "failed") {
              throw new Error("transport failed");
            }
            return false;
          },
        },
      });
      await expect(tool.execute("failed-delivery", validArgs)).rejects.toThrow(
        "prompt delivery failed",
      );
      expect(yielded).toHaveBeenCalledOnce();
      expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual([
        "question.request",
        "question.resolve",
      ]);
    },
  );

  it("keeps questions transient without a native handoff owner", async () => {
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        expect(params.durable).toBeUndefined();
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return {
          status: "answered",
          answers: { answers: { deploy_target: ["Staging (Recommended)"] } },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const tool = createAskUserTool({ gatewayCall: gateway.call });
    expect(tool.executionMode).toBeUndefined();
    await tool.execute("harness-call", validArgs);
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual([
      "question.request",
      "question.waitAnswer",
    ]);
  });

  it("rejects credential questions before acquiring durable custody", async () => {
    const gateway = gatewayStub(async () => {
      throw new Error("Unexpected question registration");
    });
    const yielded = vi.fn();
    const tool = createAskUserTool({ gatewayCall: gateway.call, nativeQuestionHandoff: yielded });
    await expect(
      tool.execute("secret-call", {
        questions: [{ ...validArgs.questions[0], isSecret: true, options: [] }],
      }),
    ).rejects.toThrow("model-facing question contract");
    expect(gateway.mock).not.toHaveBeenCalled();
    expect(yielded).not.toHaveBeenCalled();
  });
});
