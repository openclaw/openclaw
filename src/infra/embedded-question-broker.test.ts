import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionRequestParams } from "../../packages/gateway-protocol/src/index.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { resolveActiveEmbeddedRunRecoveryBlocker } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createGatewayQuestionCanceller } from "../agents/tools/gateway-question-lifecycle.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  EmbeddedQuestionBroker,
  clearEmbeddedQuestionBroker,
  getEmbeddedQuestionBroker,
  setEmbeddedQuestionBroker,
} from "./embedded-question-broker.js";

const brokers: EmbeddedQuestionBroker[] = [];
const cleanups: Array<() => void> = [];
const sessionId = "embedded-question-session";
const sessionKey = "agent:main:embedded-question";
const stagingAnswers = { answers: { destination: ["Staging"] } };
let broker: EmbeddedQuestionBroker;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;

beforeEach(() => {
  clock = createGatewaySchedulerClock();
  scheduler = createTestGatewayScheduler(clock.clock);
  broker = createBroker();
});

function createBroker(onEvent?: ConstructorParameters<typeof EmbeddedQuestionBroker>[1]) {
  const created = new EmbeddedQuestionBroker(scheduler, onEvent);
  brokers.push(created);
  return created;
}

const requestParams: QuestionRequestParams = {
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

function ask(params: QuestionRequestParams = requestParams, signal?: AbortSignal) {
  const request = broker.request(params, signal);
  return { ...request, answer: broker.waitAnswer({ id: request.id }) };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  for (const activeBroker of brokers.splice(0)) {
    clearEmbeddedQuestionBroker(activeBroker);
    activeBroker.stop();
  }
  await scheduler.stop();
  vi.useRealTimers();
});

describe("EmbeddedQuestionBroker", () => {
  it.each(["expiry", "run-abort", "stop"] as const)(
    "settles the waiter and dismisses the prompt on %s",
    async (ending) => {
      vi.useFakeTimers();
      const events: Array<{ event: string; payload: unknown }> = [];
      broker = createBroker((event) => events.push(event));
      const run = new AbortController();
      const { id, answer } = ask(requestParams, run.signal);
      if (ending === "expiry") {
        await clock.advanceBy(5_000);
      } else if (ending === "run-abort") {
        run.abort();
      } else {
        broker.stop();
      }
      const status = ending === "expiry" ? "expired" : "cancelled";
      expect(await answer).toEqual({ status });
      expect(events.at(-1)).toEqual({ event: "question.resolved", payload: { id, status } });
      expect(broker.list().questions).toEqual([]);
    },
  );

  it.each(["answer", "owner-close", "authority-only"] as const)(
    "settles an admitted question on %s",
    async (ending) => {
      const authorityOnly = ending === "authority-only";
      const admission = prepareSystemAgentRunAdmission({}, "question-run", "main", "test");
      cleanups.push(() => admission.close());
      const admittedRunContext = await admission.admit("embedded");
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext,
        agentId: "main",
        sessionKey,
      });
      let identity = caller;
      if (authorityOnly) {
        if (!caller?.approvalAuthority) {
          throw new Error("expected an admitted approval authority");
        }
        identity = {
          agentId: caller.agentId,
          sessionKey: caller.sessionKey,
          approvalAuthority: caller.approvalAuthority,
        };
      }
      await withGatewayToolCallerIdentity(identity, async () => {
        if (!authorityOnly) {
          const handle = createEmbeddedRunHandle({ runId: "question-run", isStreaming: false });
          setActiveEmbeddedRun(sessionId, handle, sessionKey);
          cleanups.push(() => clearActiveEmbeddedRun(sessionId, handle, sessionKey));
        }
        const { id, answer } = ask();
        if (!authorityOnly) {
          expect(broker.get({ id }).question).toMatchObject({ sessionKey, runId: "question-run" });
          expect(resolveActiveEmbeddedRunRecoveryBlocker(sessionId)).toBe("human_input_wait");
        }
        if (ending === "answer") {
          broker.resolve({ id, answers: stagingAnswers });
        } else {
          admission.close();
        }
        expect(await answer).toEqual(
          authorityOnly
            ? { status: "cancelled" }
            : expect.objectContaining({ status: ending === "answer" ? "answered" : "cancelled" }),
        );
        expect(resolveActiveEmbeddedRunRecoveryBlocker(sessionId)).toBeUndefined();
        if (authorityOnly) {
          expect(() => broker.request({ ...requestParams, id: "retired-question" })).toThrow(
            "no longer active",
          );
        }
      });
    },
  );

  it("supports plain secret protocol questions but refuses store-bound input before publication", async () => {
    const events: string[] = [];
    broker = createBroker((event) => events.push(event.event));
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
    const { id, answer } = ask({ questions: [question] });
    const answers = { answers: { secret_value: ["synthetic-secret"] } };
    broker.resolve({ id, answers });
    expect(await answer).toMatchObject({
      status: "answered",
      answers: { answers: { secret_value: ["synthetic-secret"] } },
    });
  });

  it("lets shared cancellation recover an answer that won the race", async () => {
    const request = broker.request(requestParams);
    broker.resolve({ id: request.id, answers: stagingAnswers });
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
    await expect(broker.call("question.request", { questions: [] })).rejects.toThrow(
      "Invalid question.request params",
    );
    const request = broker.request(requestParams);
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
    const first = broker;
    const replacement = createBroker();
    setEmbeddedQuestionBroker(first);
    setEmbeddedQuestionBroker(replacement);
    clearEmbeddedQuestionBroker(first);
    expect(getEmbeddedQuestionBroker()).toBe(replacement);
    clearEmbeddedQuestionBroker(replacement);
    expect(getEmbeddedQuestionBroker()).toBeNull();
  });
});
