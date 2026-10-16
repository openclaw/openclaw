// @vitest-environment node
// One Gateway client owns question outcomes across chat panes and sidebar projections.
import type { QuestionResolveResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  cancelQuestionPrompt,
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
  submitQuestionPrompt,
} from "./question-prompt.ts";

type QuestionState = ReturnType<typeof createQuestionPromptState>;
type QuestionClient = {
  request: (method: string, params?: unknown) => Promise<unknown>;
};

const states: QuestionState[] = [];

function createQuestionClient(): QuestionClient {
  return {
    request: vi.fn(async (_method: string, params?: unknown) =>
      (params as { cancel?: boolean } | undefined)?.cancel
        ? ({ status: "cancelled" } satisfies QuestionResolveResult)
        : ({
            status: "answered",
            answers: { answers: { format: ["Compact"] } },
          } satisfies QuestionResolveResult),
    ),
  };
}

function requestQuestion(
  state: QuestionState,
  id = "question-1",
  expiresAtMs = Date.now() + 60_000,
): void {
  handleQuestionPromptEvent(state, {
    event: "question.requested",
    payload: {
      id,
      agentId: "main",
      sessionKey: "agent:main:main",
      questions: [
        {
          questionId: "format",
          header: "Format",
          question: "Which format should I use?",
          options: [{ label: "Compact" }, { label: "Detailed" }],
        },
      ],
      createdAtMs: 1_000,
      expiresAtMs,
      status: "pending",
    },
  });
}

function connectQuestionState(
  client: QuestionClient,
  onChange: () => void = vi.fn(),
  expiresAtMs?: number,
): QuestionState {
  const state = createState(client, onChange);
  requestQuestion(state, "question-1", expiresAtMs);
  return state;
}

function createState(client: QuestionClient, onChange: () => void = vi.fn()): QuestionState {
  const state = createQuestionPromptState(onChange);
  states.push(state);
  setQuestionPromptClient(state, client);
  return state;
}

const resolutionCases = [
  {
    action: "answer",
    status: "answered",
    resolve: (state: QuestionState) =>
      submitQuestionPrompt(state, "question-1", { format: [" Compact "] }),
  },
  {
    action: "cancellation",
    status: "cancelled",
    resolve: (state: QuestionState) => cancelQuestionPrompt(state, "question-1"),
  },
] as const;

afterEach(() => {
  for (const state of states.splice(0)) {
    disposeQuestionPromptState(state);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Gateway-client question outcome ownership", () => {
  it("shares connection hydration across sidebar, favicon, and later chat mounts", async () => {
    vi.useFakeTimers();
    const client: QuestionClient = { request: vi.fn(async () => ({ questions: [] })) };
    const mount = () => {
      const state = createState(client);
      refreshPendingQuestionsWithRetry(state, client);
      return state;
    };
    const sidebar = mount();
    mount();
    await vi.advanceTimersByTimeAsync(0);
    mount();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(client.request).toHaveBeenCalledTimes(1);
    requestQuestion(sidebar);
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it.each(resolutionCases)(
    "publishes an authoritative $action to every same-client pane and sidebar owner",
    async ({ resolve, status }) => {
      const client = createQuestionClient();
      const submitter = connectQuestionState(client);
      const splitPane = connectQuestionState(client);
      const sidebar = connectQuestionState(client);

      await resolve(submitter);

      expect(submitter.prompts.get("question-1")).toMatchObject({
        status,
        localResolutionConfirmed: true,
        answeredElsewhere: false,
        submitting: false,
      });
      for (const peer of [splitPane, sidebar]) {
        expect(peer.prompts.get("question-1")).toMatchObject({
          status,
          localResolutionConfirmed: false,
          answeredElsewhere: status === "answered",
          submitting: false,
        });
      }
      if (status === "answered") {
        expect(splitPane.prompts.get("question-1")?.answers).toEqual({
          answers: { format: ["Compact"] },
        });
      }
      expect(client.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(resolutionCases)(
    "retains an authoritative $action until a same-client projection finishes hydration",
    async ({ resolve, status }) => {
      const list = createDeferred<unknown>();
      const resolver = createQuestionClient();
      const client: QuestionClient = {
        request: vi.fn((method, params) =>
          method === "question.list" ? list.promise : resolver.request(method, params),
        ),
      };
      const submitter = connectQuestionState(client);
      const stalePending = { ...submitter.prompts.get("question-1"), status: "pending" };
      const hydrating = createState(client);
      refreshPendingQuestionsWithRetry(hydrating, client);

      await resolve(submitter);

      expect(hydrating.unmatchedResolutions.get("question-1")).toMatchObject({
        id: "question-1",
        status,
      });
      list.resolve({ questions: [stalePending] });
      await vi.waitFor(() =>
        expect(hydrating.prompts.get("question-1")).toMatchObject({
          status,
          answeredElsewhere: status === "answered",
          localResolutionConfirmed: false,
        }),
      );
      expect(hydrating.unmatchedResolutions.size).toBe(0);
    },
  );

  it.each(resolutionCases)(
    "recovers a committed $action when a peer mounts before its ordered RPC response",
    async ({ resolve, status }) => {
      const resolution = createDeferred<QuestionResolveResult>();
      const list = createDeferred<{ questions: unknown[] }>();
      const client: QuestionClient = {
        request: vi.fn((method) => {
          if (method === "question.resolve") {
            return resolution.promise;
          }
          if (method === "question.list") {
            return list.promise;
          }
          return Promise.resolve({ question: terminalRecord });
        }),
      };
      const submitter = connectQuestionState(client);
      const answers = { answers: { format: ["Compact"] } };
      const terminalRecord = {
        ...submitter.prompts.get("question-1"),
        status,
        ...(status === "answered" ? { answers } : {}),
      };
      const submission = resolve(submitter);
      const hydrating = createState(client);
      refreshPendingQuestionsWithRetry(hydrating, client);
      expect(vi.mocked(client.request).mock.calls.map(([method]) => method)).toEqual([
        "question.resolve",
        "question.list",
      ]);

      resolution.resolve(status === "answered" ? { status, answers } : { status });
      await submission;
      expect(hydrating.unmatchedResolutions.has("question-1")).toBe(true);
      list.resolve({ questions: [] });

      await vi.waitFor(() =>
        expect(hydrating.prompts.get("question-1")).toMatchObject({
          status,
          answeredElsewhere: status === "answered",
          localResolutionConfirmed: false,
        }),
      );
      expect(vi.mocked(client.request).mock.calls.map(([method]) => method)).toEqual([
        "question.resolve",
        "question.list",
        "question.get",
      ]);
      expect(hydrating.unmatchedResolutions.size).toBe(0);
    },
  );

  it("does not leak a same-id answer into another Gateway client", async () => {
    const submitter = connectQuestionState(createQuestionClient());
    const otherGateway = connectQuestionState(createQuestionClient());

    await submitQuestionPrompt(submitter, "question-1", { format: ["Compact"] });

    expect(otherGateway.prompts.get("question-1")).toMatchObject({
      status: "pending",
      localResolutionConfirmed: false,
    });
  });

  it("does not settle an unrelated same-client session question", async () => {
    const client = createQuestionClient();
    const submitter = connectQuestionState(client);
    const otherSession = createState(client);
    requestQuestion(otherSession, "other-session-question");

    await cancelQuestionPrompt(submitter, "question-1");

    expect(otherSession.prompts.get("other-session-question")?.status).toBe("pending");
  });

  it("unregisters a disconnected peer without discarding its reconnectable prompt", async () => {
    const client = createQuestionClient();
    const submitter = connectQuestionState(client);
    const disconnected = connectQuestionState(client);
    setQuestionPromptClient(disconnected, null);

    await cancelQuestionPrompt(submitter, "question-1");

    expect(disconnected.prompts.get("question-1")?.status).toBe("pending");
    setQuestionPromptClient(disconnected, client);
    expect(disconnected.prompts.get("question-1")?.status).toBe("pending");
  });

  it("unregisters a disposed peer before a sibling receives its RPC result", async () => {
    const client = createQuestionClient();
    const submitter = connectQuestionState(client);
    const onPeerChange = vi.fn();
    const disposed = connectQuestionState(client, onPeerChange);
    onPeerChange.mockClear();
    disposeQuestionPromptState(disposed);

    await cancelQuestionPrompt(submitter, "question-1");

    expect(disposed.prompts.get("question-1")?.status).toBe("pending");
    expect(onPeerChange).not.toHaveBeenCalled();
  });

  it.each(resolutionCases)(
    "publishes a committed $action to surviving peers after the submitting pane is disposed",
    async ({ resolve, status }) => {
      const pending = createDeferred<QuestionResolveResult>();
      const client: QuestionClient = {
        request: vi.fn(() => pending.promise),
      };
      const onSubmitterChange = vi.fn();
      const submitter = connectQuestionState(client, onSubmitterChange);
      const peer = connectQuestionState(client);
      const sidebar = connectQuestionState(client);
      const submission = resolve(submitter);
      onSubmitterChange.mockClear();
      disposeQuestionPromptState(submitter);
      const result: QuestionResolveResult =
        status === "answered"
          ? { status, answers: { answers: { format: ["Compact"] } } }
          : { status };
      pending.resolve(result);

      await submission;

      expect(submitter.prompts.get("question-1")?.status).toBe("pending");
      expect(onSubmitterChange).not.toHaveBeenCalled();
      for (const projection of [peer, sidebar]) {
        expect(projection.prompts.get("question-1")).toMatchObject({
          status,
          answeredElsewhere: status === "answered",
          localResolutionConfirmed: false,
          submitting: false,
        });
      }
    },
  );

  it("does not deliver an old client result to a peer rebound to another Gateway", async () => {
    const firstClient = createQuestionClient();
    const submitter = connectQuestionState(firstClient);
    const migrated = connectQuestionState(firstClient);
    setQuestionPromptClient(migrated, createQuestionClient());
    requestQuestion(migrated);

    await cancelQuestionPrompt(submitter, "question-1");

    expect(migrated.prompts.get("question-1")?.status).toBe("pending");
  });

  it("purges a disposed answer and unmatched private outcome before attaching another Gateway", () => {
    const firstClient = createQuestionClient();
    const reused = connectQuestionState(firstClient);
    handleQuestionPromptEvent(reused, {
      event: "question.resolved",
      payload: {
        id: "question-1",
        status: "answered",
        answers: { answers: { format: ["Private account answer"] } },
      },
    });
    handleQuestionPromptEvent(reused, {
      event: "question.resolved",
      payload: { id: "private-unmatched-question", status: "cancelled" },
    });
    disposeQuestionPromptState(reused);

    setQuestionPromptClient(reused, createQuestionClient());

    expect(reused.prompts.size).toBe(0);
    expect(reused.unmatchedResolutions.size).toBe(0);
  });

  it("keeps and reconnects a disposed question projection on its original Gateway", async () => {
    const client = createQuestionClient();
    const submitter = connectQuestionState(client);
    const remounted = connectQuestionState(client);
    handleQuestionPromptEvent(remounted, {
      event: "question.resolved",
      payload: { id: "same-gateway-unmatched-question", status: "cancelled" },
    });
    disposeQuestionPromptState(remounted);
    setQuestionPromptClient(remounted, client);

    expect(remounted.prompts.get("question-1")?.status).toBe("pending");
    expect(remounted.unmatchedResolutions.has("same-gateway-unmatched-question")).toBe(true);
    await cancelQuestionPrompt(submitter, "question-1");
    expect(remounted.prompts.get("question-1")?.status).toBe("cancelled");
  });

  it("notifies only at question deadlines and honors an earlier incoming expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const onChange = vi.fn();
    const expiresAtMs = Date.now() + 10_000;
    const state = connectQuestionState(createQuestionClient(), onChange, expiresAtMs);
    onChange.mockClear();

    vi.advanceTimersByTime(4_000);
    expect(onChange).not.toHaveBeenCalled();
    requestQuestion(state, "question-2", Date.now() + 1_250);
    onChange.mockClear();

    vi.advanceTimersByTime(1_249);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(state.prompts.get("question-2")?.status).toBe("expired");
    expect(state.prompts.get("question-1")?.status).toBe("pending");
    expect(onChange).toHaveBeenCalledOnce();
    onChange.mockClear();

    vi.advanceTimersByTime(expiresAtMs - Date.now() - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(state.prompts.get("question-1")?.status).toBe("expired");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("publishes and expires a pending question recovered only from question.list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const client: QuestionClient = {
      request: vi.fn(async () => ({ questions: [pending] })),
    };
    const existing = connectQuestionState(client, vi.fn(), Date.now() + 1_000);
    const pending = { ...existing.prompts.get("question-1"), status: "pending" };
    const onChange = vi.fn();
    const hydrated = createQuestionPromptState(onChange);
    states.push(hydrated);
    setQuestionPromptClient(hydrated, client);

    refreshPendingQuestionsWithRetry(hydrated, client);
    await vi.advanceTimersByTimeAsync(0);

    expect(onChange).toHaveBeenCalledOnce();
    expect(hydrated.prompts.get("question-1")?.status).toBe("pending");
    expect(hydrated.expiryTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hydrated.prompts.get("question-1")).toMatchObject({
      status: "expired",
      locallyExpired: true,
    });
  });

  it("expires remounted pane and sidebar questions while their Gateway hydration remains stalled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const stalledList = new Promise<never>(() => {});
    const client: QuestionClient = { request: vi.fn(() => stalledList) };
    const expiresAtMs = Date.now() + 1_000;
    const pane = connectQuestionState(client, vi.fn(), expiresAtMs);
    const sidebar = connectQuestionState(client, vi.fn(), expiresAtMs);
    for (const projection of [pane, sidebar]) {
      disposeQuestionPromptState(projection);
      setQuestionPromptClient(projection, client);
      refreshPendingQuestionsWithRetry(projection, client);
    }
    expect(client.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);

    for (const projection of [pane, sidebar]) {
      expect(projection.prompts.get("question-1")).toMatchObject({
        status: "expired",
        locallyExpired: true,
        submitting: false,
      });
    }
  });

  it("rejects a stale same-client hydration result after the sidebar remounts", async () => {
    const pendingLists: ReturnType<typeof createDeferred<unknown>>[] = [];
    const client: QuestionClient = {
      request: vi.fn((method: string) => {
        const pending = createDeferred<unknown>();
        if (method === "question.list") {
          pendingLists.push(pending);
        }
        return pending.promise;
      }),
    };
    const remounted = connectQuestionState(client);
    refreshPendingQuestionsWithRetry(remounted, client);
    disposeQuestionPromptState(remounted);
    setQuestionPromptClient(remounted, client);
    refreshPendingQuestionsWithRetry(remounted, client);
    expect(pendingLists).toHaveLength(2);

    pendingLists[0]?.resolve({
      questions: [
        {
          ...remounted.prompts.get("question-1"),
          id: "stale-before-remount",
          status: "pending",
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(remounted.prompts.has("stale-before-remount")).toBe(false);
  });

  it("does not publish an old request rejected when its Gateway reconnects", async () => {
    const pending = createDeferred<QuestionResolveResult>();
    const client: QuestionClient = {
      request: vi.fn(() => pending.promise),
    };
    const submitter = connectQuestionState(client);
    const peer = connectQuestionState(client);
    const submission = cancelQuestionPrompt(submitter, "question-1");
    // The protocol rejects pending requests before its reconnect lifecycle.
    pending.reject(new Error("gateway closed"));
    for (const projection of [submitter, peer]) {
      setQuestionPromptClient(projection, null);
      setQuestionPromptClient(projection, client);
    }

    await submission;

    expect(submitter.prompts.get("question-1")?.status).toBe("pending");
    expect(peer.prompts.get("question-1")?.status).toBe("pending");
  });

  it("skips a peer rebound to a newer generation during reentrant publication", async () => {
    const client = createQuestionClient();
    const submitter = connectQuestionState(client);
    let publishStarted = false;
    const reentrant = connectQuestionState(client, () => {
      if (!publishStarted) {
        return;
      }
      publishStarted = false;
      setQuestionPromptClient(rebound, null);
      setQuestionPromptClient(rebound, client);
    });
    const rebound = connectQuestionState(client);
    publishStarted = true;

    await cancelQuestionPrompt(submitter, "question-1");

    expect(reentrant.prompts.get("question-1")?.status).toBe("cancelled");
    expect(rebound.prompts.get("question-1")?.status).toBe("pending");
  });
});
