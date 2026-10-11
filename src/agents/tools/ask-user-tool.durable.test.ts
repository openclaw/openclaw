import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { gatewayStub, validArgs } from "./ask-user-tool.gateway.test-fixture.js";
import { createAskUserTool } from "./ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./ask-user-tool.test-support.js";

afterEach(resetPendingAskUserQuestionsForTest);

describe("native durable ask_user handoff", () => {
  it("commits registration and delivers the prompt before yielding without a live answer waiter", async () => {
    const delivered = createDeferred();
    const yielded = vi.fn();
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id, durable: true };
      }
      throw new Error(`Unexpected live waiter: ${method}`);
    });
    const send = vi.fn(async () => delivered.promise);
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
  });

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

  it("hands off a committed question even when prompt delivery fails", async () => {
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
          throw new Error("transport failed");
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
  });

  it("keeps generic harness yield callbacks on the transient answer path", async () => {
    const yielded = vi.fn();
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
    const tool = createAskUserTool({ gatewayCall: gateway.call, onYield: yielded });
    expect(tool.executionMode).toBeUndefined();
    await tool.execute("harness-call", validArgs);
    expect(yielded).not.toHaveBeenCalled();
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
