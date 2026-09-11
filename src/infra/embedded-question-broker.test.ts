import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QuestionGetResultSchema,
  QuestionListResultSchema,
  QuestionRequestedEventSchema,
  QuestionRequestResultSchema,
  QuestionResolvedEventSchema,
  QuestionResolveResultSchema,
  QuestionWaitAnswerResultSchema,
  type QuestionRequestParams,
} from "../../packages/gateway-protocol/src/index.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { resolveActiveEmbeddedRunRecoveryBlocker } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../agents/embedded-agent-runner/runs.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createGatewayQuestionCanceller } from "../agents/tools/gateway-question-lifecycle.js";
import {
  EmbeddedQuestionBroker,
  clearEmbeddedQuestionBroker,
  getEmbeddedQuestionBroker,
  setEmbeddedQuestionBroker,
} from "./embedded-question-broker.js";

const brokers: EmbeddedQuestionBroker[] = [];

function createBroker() {
  const broker = new EmbeddedQuestionBroker();
  brokers.push(broker);
  return broker;
}

function requestParams(): QuestionRequestParams {
  return {
    id: "local-question",
    sessionKey: "agent:main:main",
    agentId: "main",
    runId: "local-run",
    timeoutMs: 5_000,
    questions: [
      {
        questionId: "destination",
        header: "Destination",
        question: "Where should the preview run?",
        options: [{ label: "Staging" }, { label: "Production" }],
        isOther: true,
      },
    ],
  };
}

afterEach(() => {
  for (const broker of brokers.splice(0)) {
    clearEmbeddedQuestionBroker(broker);
    broker.stop();
  }
  vi.useRealTimers();
});

describe("EmbeddedQuestionBroker", () => {
  it("publishes a protocol question and resolves its waiting tool with a correlated answer", async () => {
    const broker = createBroker();
    const events: Array<{ event: string; payload: unknown }> = [];
    broker.subscribe((event) => events.push(event));
    const request = broker.request(requestParams());
    const listed = broker.list();
    const fetched = broker.get({ id: request.id });

    expect(Value.Check(QuestionRequestResultSchema, request)).toBe(true);
    expect(Value.Check(QuestionListResultSchema, listed)).toBe(true);
    expect(Value.Check(QuestionGetResultSchema, fetched)).toBe(true);
    expect(listed.questions).toEqual([fetched.question]);
    expect(events).toEqual([{ event: "question.requested", payload: fetched.question }]);
    expect(Value.Check(QuestionRequestedEventSchema, events[0]?.payload)).toBe(true);

    const answer = broker.waitAnswer({ id: request.id, includeResolutionId: true });
    const resolved = broker.resolve({
      id: request.id,
      answers: { answers: { destination: [" Staging "] } },
      resolutionId: "local-answer",
    });
    expect(Value.Check(QuestionResolveResultSchema, resolved)).toBe(true);
    expect(await answer).toEqual({
      status: "answered",
      answers: { answers: { destination: ["Staging"] } },
      resolutionId: "local-answer",
    });
    expect(Value.Check(QuestionWaitAnswerResultSchema, await answer)).toBe(true);
    expect(Value.Check(QuestionResolvedEventSchema, events[1]?.payload)).toBe(true);
    expect(events[1]).toEqual({
      event: "question.resolved",
      payload: { id: request.id, ...resolved },
    });
    expect(broker.list().questions).toEqual([]);
    expect(broker.get({ id: request.id }).question.status).toBe("answered");
  });

  it.each(["cancel", "expiry", "run-abort", "stop"] as const)(
    "settles the waiter and dismisses the prompt on %s",
    async (ending) => {
      vi.useFakeTimers();
      const broker = createBroker();
      const events: Array<{ event: string; payload: unknown }> = [];
      broker.subscribe((event) => events.push(event));
      const run = new AbortController();
      const request = broker.request(requestParams(), run.signal);
      const answer = broker.waitAnswer({ id: request.id });
      if (ending === "cancel") {
        broker.resolve({ id: request.id, cancel: true });
      } else if (ending === "expiry") {
        await vi.advanceTimersByTimeAsync(5_000);
      } else if (ending === "run-abort") {
        run.abort();
      } else {
        broker.stop();
      }
      const status = ending === "expiry" ? "expired" : "cancelled";
      expect(await answer).toEqual({ status });
      expect(events.at(-1)).toEqual({
        event: "question.resolved",
        payload: { id: request.id, status },
      });
      expect(broker.list().questions).toEqual([]);
    },
  );

  it("leaves an unanswered prompt pending when only the wait deadline ends", async () => {
    vi.useFakeTimers();
    const broker = createBroker();
    const request = broker.request(requestParams());
    const answer = broker.waitAnswer({ id: request.id, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await answer).toEqual({ status: "pending" });
    expect(broker.get({ id: request.id }).question.status).toBe("pending");
  });

  it.each(["answer", "owner-close"] as const)(
    "holds the admitted run's human-input wait until %s",
    async (ending) => {
      const broker = createBroker();
      const sessionId = "embedded-question-session";
      const sessionKey = "agent:main:embedded-question";
      const admission = prepareSystemAgentRunAdmission({}, "question-run", "main", "test");
      const admitted = await admission.admit("embedded");
      const handle: EmbeddedAgentQueueHandle = {
        runId: "question-run",
        queueMessage: async () => {},
        isStreaming: () => false,
        isCompacting: () => false,
        abort: () => {},
      };
      try {
        const request = await withGatewayToolCallerIdentity(
          createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: "main",
            sessionKey,
          }),
          () => {
            setActiveEmbeddedRun(sessionId, handle, sessionKey);
            return broker.request(requestParams());
          },
        );
        const answer = broker.waitAnswer({ id: request.id });
        expect(broker.get({ id: request.id }).question).toMatchObject({
          sessionKey,
          runId: "question-run",
        });
        expect(resolveActiveEmbeddedRunRecoveryBlocker(sessionId)).toBe("human_input_wait");
        if (ending === "answer") {
          broker.resolve({ id: request.id, answers: { answers: { destination: ["Staging"] } } });
        } else {
          admission.close();
        }
        expect(await answer).toMatchObject({
          status: ending === "answer" ? "answered" : "cancelled",
        });
        expect(resolveActiveEmbeddedRunRecoveryBlocker(sessionId)).toBeUndefined();
      } finally {
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        admission.close();
      }
    },
  );

  it("supports plain secret protocol questions but refuses store-bound input before publication", async () => {
    const broker = createBroker();
    const events: string[] = [];
    broker.subscribe((event) => events.push(event.event));
    const question = {
      questionId: "secret_value",
      header: "Secret",
      question: "Enter a synthetic secret.",
      options: [],
      isSecret: true,
    };
    await expect(
      broker.call("question.request", {
        questions: [{ ...question, secretStore: { name: "TEST_KEY", kind: "secret" } }],
      }),
    ).rejects.toThrow("Secret store requests need a running Gateway");
    expect(events).toEqual([]);
    const request = broker.request({ questions: [question] });
    const answer = broker.waitAnswer({ id: request.id });
    broker.resolve({
      id: request.id,
      answers: { answers: { secret_value: ["synthetic-secret"] } },
    });
    expect(await answer).toMatchObject({
      status: "answered",
      answers: { answers: { secret_value: ["synthetic-secret"] } },
    });
  });

  it("retires a captured approval authority even without a caller run reference", async () => {
    const broker = createBroker();
    const admission = prepareSystemAgentRunAdmission({}, "authority-only-run", "main", "test");
    const admitted = await admission.admit("embedded");
    const caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    if (!caller?.approvalAuthority) {
      throw new Error("expected an admitted approval authority");
    }
    try {
      await withGatewayToolCallerIdentity(
        {
          agentId: caller.agentId,
          sessionKey: caller.sessionKey,
          approvalAuthority: caller.approvalAuthority,
        },
        async () => {
          const request = broker.request(requestParams());
          const answer = broker.waitAnswer({ id: request.id });
          admission.close();
          expect(await answer).toEqual({ status: "cancelled" });
          expect(() => broker.request({ ...requestParams(), id: "retired-question" })).toThrow(
            "no longer active",
          );
        },
      );
    } finally {
      admission.close();
    }
  });

  it("lets shared cancellation recover an answer that won the race", async () => {
    const broker = createBroker();
    const request = broker.request(requestParams());
    broker.resolve({ id: request.id, answers: { answers: { destination: ["Staging"] } } });
    const cancel = createGatewayQuestionCanceller({
      questionId: request.id,
      gatewayCall: (method, _options, params, extra) => broker.call(method, params, extra),
    });
    expect(await cancel("tool-timeout")).toEqual({
      status: "answered",
      answers: { answers: { destination: ["Staging"] } },
    });
  });

  it("validates requests and answers without losing a pending prompt", async () => {
    const broker = createBroker();
    await expect(broker.call("question.request", { questions: [] })).rejects.toThrow(
      "Invalid question.request params",
    );
    const request = broker.request(requestParams());
    await expect(
      broker.call("question.resolve", {
        id: request.id,
        answers: { answers: { destination: [] } },
      }),
    ).rejects.toMatchObject({ details: { reason: "QUESTION_INVALID_ANSWER" } });
    expect(broker.list().questions).toHaveLength(1);
    await expect(broker.call("question.get", { id: "missing" })).rejects.toMatchObject({
      details: { reason: "QUESTION_NOT_FOUND" },
    });
  });

  it("does not clear a replacement backend's registration when an older one stops", () => {
    const first = createBroker();
    const replacement = createBroker();
    setEmbeddedQuestionBroker(first);
    setEmbeddedQuestionBroker(replacement);
    clearEmbeddedQuestionBroker(first);
    expect(getEmbeddedQuestionBroker()).toBe(replacement);
    clearEmbeddedQuestionBroker(replacement);
    expect(getEmbeddedQuestionBroker()).toBeNull();
  });
});
