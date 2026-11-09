// @vitest-environment node
// Control UI tests cover operator question parsing and lifecycle state.
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  type GatewayProtocolRequestOptions,
} from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { i18n } from "../i18n/index.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  answeredPayload,
  compactAnswer,
  createQuestionHarness,
  createQuestionResolver,
  defaultRequestDeadline,
  detailedAnswer,
  expectPrompt,
  questionNotFoundError,
  recordQuestionResolution,
  requestedPayload,
  requestQuestion,
  resolvedQuestion,
  type QuestionState,
  type RequestFn,
} from "./question-prompt.test-support.ts";
import {
  cancelQuestionPrompt,
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
  submitQuestionPrompt,
} from "./question-prompt.ts";

const { createState, createConnectedState } = createQuestionHarness();

function rejectAfterRequestDeadline(options?: GatewayProtocolRequestOptions): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timeoutMs = options?.timeoutMs;
    if (typeof timeoutMs === "number") {
      setTimeout(
        () => reject(new Error(`gateway request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }
  });
}

function createDeferredQuestionRequest() {
  const pending = createDeferred<unknown>();
  const request = vi.fn<RequestFn>(() => pending.promise);
  return {
    request,
    resolve: () => pending.resolve(resolvedQuestion(request.mock.calls.at(-1)?.[1])),
    reject: (message = "stale gateway unavailable") => pending.reject(new Error(message)),
  };
}

function expectQuestionGet(request: RequestFn) {
  expect(request).toHaveBeenCalledWith(
    "question.get",
    { id: "question-1" },
    defaultRequestDeadline,
  );
}

function answerQuestion(state: QuestionState) {
  return submitQuestionPrompt(state, "question-1", { format: ["Compact"] });
}

describe("question event parsing", () => {
  it("round-trips requested and resolved event payloads", () => {
    const state = createState();
    expect(requestQuestion(state)).toBe(true);
    expectPrompt(state, {
      id: "question-1",
      runId: "run-question",
      sessionKey: "agent:main:main",
      status: "pending",
      questions: [{ questionId: "format", options: [{ label: "Compact" }, { label: "Detailed" }] }],
    });
    expect(
      recordQuestionResolution(state, {
        id: "question-1",
        status: "answered",
        answers: compactAnswer,
      }),
    ).toBe(true);
    expectPrompt(state, {
      runId: "run-question",
      status: "answered",
      answers: compactAnswer,
    });
  });

  it("preserves question and option display normalization for canonical Gateway records", () => {
    const state = createState();
    const question = requestedPayload().questions[0]!;
    const media = {
      presentation: "form",
      resource: { viewId: "form-view", selection: "explicit" },
      options: [
        {
          label: "  Compact  ",
          thumbnail: "https://example.test/compact.png",
          resourceUri: "https://example.test/compact",
          preview: { type: "resource_link", uri: "https://example.test/compact", name: "Compact" },
        },
      ],
    };
    requestQuestion(state, {
      questions: [{ ...question, ...media, question: "  Which format?  " }],
    });
    expect(state.prompts.get("question-1")?.questions[0]).toMatchObject({
      ...media,
      question: "Which format?",
      options: [{ ...media.options[0], label: "Compact" }],
    });
  });

  it.each(["question", "label"])("rejects an empty-after-trim %s", (field) => {
    const state = createState();
    const question = requestedPayload().questions[0]!;
    expect(
      requestQuestion(state, {
        questions: [
          field === "question"
            ? { ...question, question: "  " }
            : { ...question, options: [{ label: "  " }] },
        ],
      }),
    ).toBe(false);
    expect(state.prompts.size).toBe(0);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,sign-in",
    "/sign-in",
    "//example.test/sign-in",
    "https://operator:password@example.test/sign-in",
    "https://",
    42,
  ])("rejects unsafe external question URLs: %s", (url) => {
    const state = createState();
    const question = requestedPayload().questions[0];
    expect(requestQuestion(state, { questions: [{ ...question, url }] })).toBe(false);
    expect(state.prompts.size).toBe(0);
  });
});

describe("question prompt state", () => {
  it.each(["cancelled", "expired"] as const)("transitions requested to %s", (status) => {
    const state = createState();
    expect(requestQuestion(state)).toBe(true);

    recordQuestionResolution(state, { id: "question-1", status });

    expect(state.prompts.get("question-1")?.status).toBe(status);
  });

  it("marks answers from another surface", () => {
    const state = createState();
    requestQuestion(state);
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: detailedAnswer,
    });

    expectPrompt(state, {
      status: "answered",
      answeredElsewhere: true,
      answers: detailedAnswer,
    });
  });

  it.each([
    { outcome: "confirmed local broadcast", answers: compactAnswer, error: null, local: true },
    {
      outcome: "concurrent remote winner",
      answers: detailedAnswer,
      error: "question already resolved",
      local: false,
    },
    {
      outcome: "lost local response",
      answers: compactAnswer,
      error: "connection closed",
      local: false,
    },
  ])("preserves provenance after a $outcome", async ({ answers, error, local }) => {
    const pending = createDeferredQuestionRequest();
    const { state } = createConnectedState(pending.request);
    const submitting = answerQuestion(state);
    recordQuestionResolution(state, { id: "question-1", status: "answered", answers });
    if (error) {
      pending.reject(error);
    } else {
      pending.resolve();
    }
    await submitting;
    expectPrompt(state, {
      status: "answered",
      answers,
      submitting: false,
      answeredElsewhere: answers === detailedAnswer,
      localResolutionConfirmed: local,
    });
  });

  it("surfaces a retryable error when submission happens while disconnected", async () => {
    const translate = vi
      .spyOn(i18n, "t")
      .mockImplementation((key) =>
        key === "chat.questions.disconnected" ? "Localized reconnect guidance" : key,
      );
    const state = createState();
    requestQuestion(state);

    await submitQuestionPrompt(state, "question-1", { format: ["Compact"] });

    expectPrompt(state, {
      status: "pending",
      submitting: false,
      error: "Localized reconnect guidance",
    });
    expect(translate).toHaveBeenCalledWith("chat.questions.disconnected", undefined);
  });
});

describe("question RPC helpers", () => {
  it("sends option labels, free text, and multi-select arrays in the frozen answer shape", async () => {
    const request = createQuestionResolver();
    const questions = [
      ...requestedPayload().questions,
      {
        questionId: "destination",
        header: "Destination",
        question: "Where should I send it?",
        options: [],
        isOther: true,
      },
      {
        questionId: "extras",
        header: "Extras",
        question: "What should I include?",
        options: [{ label: "Tests" }, { label: "Docs" }],
        multiSelect: true,
      },
    ];
    const { state } = createConnectedState(request, { questions });

    await submitQuestionPrompt(state, "question-1", {
      format: ["Compact"],
      destination: ["My own target"],
      extras: ["Tests", "Docs"],
    });

    expect(request).toHaveBeenCalledWith(
      "question.resolve",
      {
        id: "question-1",
        answers: {
          answers: {
            format: ["Compact"],
            destination: ["My own target"],
            extras: ["Tests", "Docs"],
          },
        },
      },
      defaultRequestDeadline,
    );
    expectPrompt(state, {
      status: "answered",
      localResolutionConfirmed: true,
      answeredElsewhere: false,
      submitting: false,
    });
  });

  it("cancels a pending question when the docked panel is skipped", async () => {
    const request = createQuestionResolver();
    const { state } = createConnectedState(request, requestedPayload());

    await cancelQuestionPrompt(state, "question-1");

    expect(request).toHaveBeenCalledWith(
      "question.resolve",
      { id: "question-1", cancel: true },
      defaultRequestDeadline,
    );
    expectPrompt(state, {
      status: "cancelled",
      localResolutionConfirmed: true,
      submitting: false,
    });
  });

  it.each([{}, { status: "answered" }, { status: "cancelled" }])(
    "keeps an invalid successful answer response retryable: %o",
    async (result) => {
      const request = vi.fn<RequestFn>(async () => result);
      const { state } = createConnectedState(request, requestedPayload());

      await submitQuestionPrompt(state, "question-1", { format: ["Compact"] });

      expectPrompt(state, {
        status: "pending",
        submitting: false,
        error: "invalid question.resolve response",
      });
    },
  );

  it("re-enables a stalled answer when its gateway request reaches the owner deadline", async () => {
    vi.useFakeTimers();
    const request = vi.fn<RequestFn>((_method, _params, options) =>
      rejectAfterRequestDeadline(options),
    );
    const { state } = createConnectedState(request);

    const pending = answerQuestion(state);
    expect(state.prompts.get("question-1")?.submitting).toBe(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);

    expectPrompt(state, {
      status: "pending",
      submitting: false,
      error: `gateway request timed out after ${DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS}ms`,
    });
    await pending;
  });

  it("clips an answer request to the remaining question lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const request = createQuestionResolver();
    const { state } = createConnectedState(request, { expiresAtMs: Date.now() + 1_250 });

    await answerQuestion(state);

    expect(request).toHaveBeenCalledWith("question.resolve", expect.any(Object), {
      timeoutMs: 1_250,
    });
  });
});

describe("question resolution connection ownership", () => {
  it.each(["success", "error"] as const)(
    "ignores an old answer %s after the gateway client changes",
    async (outcome) => {
      const stale = createDeferredQuestionRequest();
      const current = createDeferredQuestionRequest();
      const { state } = createConnectedState(stale.request);

      const staleResolution = answerQuestion(state);
      setQuestionPromptClient(state, { request: current.request });
      expect(state.prompts.has("question-1")).toBe(false);
      requestQuestion(state);

      const currentResolution = answerQuestion(state);
      if (outcome === "success") {
        stale.resolve();
      } else {
        stale.reject();
      }
      await staleResolution;

      expectPrompt(state, {
        status: "pending",
        submitting: true,
        localResolutionConfirmed: false,
        error: null,
      });

      current.resolve();
      await currentResolution;
      expect(state.prompts.get("question-1")?.localResolutionConfirmed).toBe(true);
    },
  );

  it("rejects an old answer when the same gateway transport reconnects", async () => {
    const stale = createDeferredQuestionRequest();
    const current = createDeferredQuestionRequest();
    let requestCount = 0;
    const client = {
      request: vi.fn<RequestFn>((method, params) => {
        requestCount += 1;
        return requestCount === 1 ? stale.request(method, params) : current.request(method, params);
      }),
    };
    const { state } = createConnectedState(client);

    const staleResolution = answerQuestion(state);
    // Socket closure rejects its pending requests before reconnect callbacks.
    stale.reject();
    setQuestionPromptClient(state, null);
    expect(state.prompts.get("question-1")?.submitting).toBe(false);
    setQuestionPromptClient(state, client);

    const currentResolution = answerQuestion(state);
    await staleResolution;

    expectPrompt(state, {
      status: "pending",
      submitting: true,
      localResolutionConfirmed: false,
      error: null,
    });

    current.resolve();
    await currentResolution;
    expect(state.prompts.get("question-1")?.localResolutionConfirmed).toBe(true);
  });

  it("keeps a current answer after same-connection prompt hydration", async () => {
    const pending = createDeferredQuestionRequest();
    const request = vi.fn<RequestFn>((method, params) =>
      method === "question.list"
        ? Promise.resolve({ questions: [requestedPayload()] })
        : pending.request(method, params),
    );
    const { state, client } = createConnectedState(request);

    const resolution = answerQuestion(state);
    const original = state.prompts.get("question-1");
    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")).not.toBe(original));

    pending.resolve();
    await resolution;

    expectPrompt(state, {
      status: "answered",
      localResolutionConfirmed: true,
      submitting: false,
      error: null,
    });
  });

  it.each([false, true])("retains records only for the same gateway: %s", (sameGateway) => {
    const client = { request: createQuestionResolver() };
    const { state } = createConnectedState(client);
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: detailedAnswer,
    });
    recordQuestionResolution(state, { id: "unmatched", status: "cancelled" });
    setQuestionPromptClient(state, null);
    setQuestionPromptClient(state, sameGateway ? client : { request: createQuestionResolver() });
    if (sameGateway) {
      expectPrompt(state, { status: "answered", answers: detailedAnswer });
      expect(state.unmatchedResolutions.has("unmatched")).toBe(true);
    } else {
      expect(state.prompts.size).toBe(0);
      expect(state.unmatchedResolutions.size).toBe(0);
    }
  });
});

describe("refreshPendingQuestions", () => {
  it("retries question hydration when the gateway leaves question.list unresolved", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const request = vi.fn<RequestFn>((_method, _params, options) => {
      attempts += 1;
      return attempts === 1
        ? rejectAfterRequestDeadline(options)
        : Promise.resolve({ questions: [requestedPayload()] });
    });
    const { state, client } = createConnectedState(request);

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.prompts.get("question-1")?.status).toBe("pending");
  });

  it("retries transient hydration failures while the client remains current", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const request = vi.fn<RequestFn>(async () => {
      attempts += 1;
      if (attempts < 5) {
        throw new Error("gateway unavailable");
      }
      return { questions: [requestedPayload()] };
    });
    const { state, client } = createConnectedState(request, null);

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(request).toHaveBeenCalledTimes(5);
    expect(state.prompts.get("question-1")?.status).toBe("pending");
  });

  it("preserves a resolution received while reconnect refresh is in flight", async () => {
    const list = createDeferred<unknown>();
    const request = vi.fn<RequestFn>(() => list.promise);
    const { state, client } = createConnectedState(request);

    refreshPendingQuestionsWithRetry(state, client);
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: detailedAnswer,
    });
    list.resolve({ questions: [requestedPayload()] });
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));

    expect(state.prompts.get("question-1")?.status).toBe("answered");
  });

  it("retains a resolution that arrives before reconnect hydration", async () => {
    const list = createDeferred<unknown>();
    const request = vi.fn<RequestFn>((method) =>
      method === "question.list" ? list.promise : Promise.resolve({ question: answeredPayload() }),
    );
    const { state, client } = createConnectedState(request, null);

    refreshPendingQuestionsWithRetry(state, client);
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: detailedAnswer,
    });
    list.resolve({ questions: [] });
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));

    expectQuestionGet(request);
    expectPrompt(state, {
      status: "answered",
      answeredElsewhere: true,
      answers: detailedAnswer,
    });
    expect(state.unmatchedResolutions.size).toBe(0);
  });

  it("recovers a terminal answer missed during disconnect", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      return {
        question: answeredPayload(),
      };
    });
    const { state, client } = createConnectedState(request, requestedPayload());

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));

    expectQuestionGet(request);
    expectPrompt(state, {
      status: "answered",
      answeredElsewhere: true,
      answers: detailedAnswer,
    });
  });

  it("keeps a missing pending question recoverable after question.get fails", async () => {
    let getAttempts = 0;
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      getAttempts += 1;
      if (getAttempts === 1) {
        throw new Error("gateway unavailable");
      }
      return { question: answeredPayload() };
    });
    const { state, client } = createConnectedState(request);

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(state.prompts.get("question-1")?.status).toBe("pending");

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));
    expectPrompt(state, {
      status: "answered",
      answeredElsewhere: true,
      answers: detailedAnswer,
    });
  });

  it("terminalizes a missing pending question with an unknown outcome after not-found", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      throw questionNotFoundError();
    });
    const { state, client } = createConnectedState(request);

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("unavailable"));

    expectPrompt(state, {
      status: "unavailable",
      answeredElsewhere: false,
      locallyExpired: false,
      submitting: false,
      error: null,
    });
  });

  it("stops retrying an unmatched resolution after its gateway tombstone ages out", async () => {
    vi.useFakeTimers();
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      throw questionNotFoundError();
    });
    const { state, client } = createConnectedState(request, null);
    recordQuestionResolution(state, { id: "forgotten-question", status: "cancelled" });
    setQuestionPromptClient(state, null);
    await vi.advanceTimersByTimeAsync(15_000);
    setQuestionPromptClient(state, client);

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.unmatchedResolutions.has("forgotten-question")).toBe(false);
    expect(state.refreshRetryTimer).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps an unmatched resolution recoverable after a transient question.get failure", async () => {
    vi.useFakeTimers();
    let getAttempts = 0;
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      getAttempts += 1;
      if (getAttempts === 1) {
        throw new Error("gateway unavailable");
      }
      return { question: answeredPayload() };
    });
    const { state, client } = createConnectedState(request, null);
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: detailedAnswer,
    });

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.unmatchedResolutions.has("question-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expectPrompt(state, {
      status: "answered",
      answeredElsewhere: true,
      answers: detailedAnswer,
    });
    expect(state.unmatchedResolutions.size).toBe(0);
  });

  it("recovers a sibling question when another question.get never responds", async () => {
    vi.useFakeTimers();
    const request = vi.fn<RequestFn>((method, params, options) => {
      if (method === "question.list") {
        return Promise.resolve({ questions: [] });
      }
      if ((params as { id: string }).id === "question-1") {
        return rejectAfterRequestDeadline(options);
      }
      return Promise.resolve({ question: answeredPayload({ id: "question-2" }) });
    });
    const { state, client } = createConnectedState(request, null);
    for (const id of ["question-1", "question-2"]) {
      requestQuestion(state, { id });
    }

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.prompts.get("question-2")).toMatchObject({
      status: "answered",
      answers: detailedAnswer,
    });
    expect(state.prompts.get("question-1")?.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
    expect(state.prompts.get("question-1")?.status).toBe("pending");
  });

  it.each(["before refresh", "during question.get", "during question.list"])(
    "reconciles expiry %s with the authoritative answer",
    async (phase) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
      const list = createDeferred<unknown>();
      const get = createDeferred<unknown>();
      const request = vi.fn<RequestFn>((method) =>
        method === "question.list"
          ? phase === "during question.list"
            ? list.promise
            : Promise.resolve({ questions: [] })
          : phase === "during question.get"
            ? get.promise
            : Promise.resolve({ question: answeredPayload() }),
      );
      const { state, client } = createConnectedState(request, { expiresAtMs: Date.now() + 1_000 });
      if (phase === "before refresh") {
        vi.advanceTimersByTime(1_000);
        expectPrompt(state, { status: "expired", locallyExpired: true });
      }
      refreshPendingQuestionsWithRetry(state, client);
      if (phase !== "before refresh") {
        if (phase === "during question.get") {
          await waitForFast(() => expectQuestionGet(request));
        }
        await vi.advanceTimersByTimeAsync(1_000);
        expect(state.prompts.get("question-1")?.locallyExpired).toBe(true);
        if (phase === "during question.get") {
          get.resolve({ question: answeredPayload() });
        } else {
          list.resolve({ questions: [] });
        }
      }
      await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));
      expectQuestionGet(request);
      expectPrompt(state, {
        status: "answered",
        locallyExpired: false,
        answeredElsewhere: true,
        answers: detailedAnswer,
      });
    },
  );

  it("publishes listed questions before older reconciliation finishes", async () => {
    const get = createDeferred<unknown>();
    const request = vi.fn<RequestFn>((method) => {
      if (method === "question.list") {
        return Promise.resolve({
          questions: [requestedPayload({ id: "question-2", createdAtMs: 2_000 })],
        });
      }
      return get.promise;
    });
    const onChange = vi.fn();
    const state = createState(onChange);
    const client = { request };
    setQuestionPromptClient(state, client);
    requestQuestion(state);
    onChange.mockClear();

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expectQuestionGet(request));

    expect(state.prompts.get("question-2")?.status).toBe("pending");
    expect(onChange).toHaveBeenCalled();

    get.resolve({ question: requestedPayload({ status: "cancelled" }) });
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("cancelled"));
  });
});
