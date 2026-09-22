// @vitest-environment jsdom
import { html, nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { SessionRefreshOutcome } from "../../lib/sessions/session-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  makeChatHost,
  makeRequestMock,
  requestCalls,
  requireRecord,
} from "./chat-host.test-support.ts";
import { ChatProviderReviewController } from "./chat-provider-review-controller.ts";

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) {
    render(nothing, container);
    container.remove();
  }
  vi.restoreAllMocks();
});

const row: GatewaySessionRow = {
  key: "agent:main:main",
  agentId: "main",
  sessionId: "original",
  kind: "direct",
  updatedAt: 1,
  providerReview: {
    id: "review-one",
    runId: "paused-run",
    canContinue: true,
    explanation: "The agent tried to modify files outside the selected project. <img src=x>",
    continuationMessage: "Continue only inside the selected project.\nPreserve all other files.",
  },
};

function fixture(review = row.providerReview) {
  const outcome = createDeferred<unknown>();
  const request = makeRequestMock({ "sessions.providerReview.continue": () => outcome.promise });
  const state = makeChatHost({
    client: createTestGatewayClient(request),
    sessionKey: row.key,
    currentSessionId: row.sessionId,
  });
  state.sessionsResult = sessionsResult([{ ...row, providerReview: review }], 1);
  const refresh = vi
    .spyOn(state.sessions, "reconcileMutation")
    .mockResolvedValue({ status: "refreshed" });
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  const paint = () => {
    controller.sync(true);
    render(html`${controller.notice()}${controller.dialog()}`, container);
  };
  const controller = new ChatProviderReviewController(
    {
      addController() {},
      removeController() {},
      requestUpdate: paint,
      updateComplete: Promise.resolve(true),
    },
    () => state,
  );
  paint();
  const click = (text: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    expect(button, text).toBeDefined();
    button!.click();
    return button!;
  };
  const open = async () => {
    click("Review findings");
    await vi.dynamicImportSettled();
    paint();
  };
  return { state, controller, container, paint, click, open, outcome, request, refresh };
}

it("requires explicit review and acknowledgment, quotes exact text, and keeps the server pause after ACK", async () => {
  const f = fixture();
  expect(requestCalls(f.request, "sessions.providerReview.continue")).toHaveLength(0);
  await f.open();
  expect(f.container.textContent).toContain(row.providerReview!.explanation);
  expect(f.container.querySelector("img")).toBeNull();
  expect(f.container.querySelector("blockquote")?.textContent).toBe(
    row.providerReview!.continuationMessage,
  );
  expect(requestCalls(f.request, "sessions.providerReview.continue")).toHaveLength(0);
  f.click("Acknowledge findings and continue");
  f.click("Requesting continuation…");
  const calls = requestCalls(f.request, "sessions.providerReview.continue");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[1]).toEqual({
    sessionKey: row.key,
    agentId: "main",
    sessionId: row.sessionId,
    reviewId: row.providerReview!.id,
    idempotencyKey: expect.any(String),
  });
  f.outcome.resolve({ runId: "resumed", status: "started" });
  await f.outcome.promise;
  await Promise.resolve();
  expect(f.refresh).toHaveBeenCalledTimes(1);
  await f.refresh.mock.results[0]?.value;
  expect(f.container.textContent).toContain("Waiting for the provider to accept it.");
  expect(f.state.sessionsResult?.sessions[0]?.providerReview).toEqual(row.providerReview);
  expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(true);
});

it.each(["connection", "session", "review"] as const)(
  "ignores a late continuation outcome after %s replacement",
  async (replacement) => {
    const f = fixture();
    await f.open();
    f.click("Acknowledge findings and continue");
    if (replacement === "connection") {
      f.state.connectionEpoch += 1;
    }
    if (replacement === "session") {
      f.state.currentSessionId = "replacement";
    }
    f.state.sessionsResult = sessionsResult(
      [
        {
          ...row,
          sessionId: replacement === "session" ? "replacement" : row.sessionId,
          providerReview: {
            ...row.providerReview!,
            id: replacement === "review" ? "review-two" : row.providerReview!.id,
          },
        },
      ],
      2,
    );
    f.paint();
    f.outcome.reject(new Error("Old connection failed"));
    await f.outcome.promise.catch(() => {});
    await Promise.resolve();
    expect(f.container.textContent).not.toContain("Old connection failed");
    expect(f.container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(f.state.sessions.reconcileMutation).not.toHaveBeenCalled();
  },
);

it.each([
  { canContinue: false, explanation: undefined, continuationMessage: undefined },
  {
    canContinue: false,
    explanation: "Reviewable findings without a continuation.",
    continuationMessage: undefined,
  },
])("keeps stopped findings non-continuable ($explanation)", async (details) => {
  const f = fixture({ ...row.providerReview!, ...details });
  if (details.explanation) {
    await f.open();
  }
  expect(f.container.textContent).not.toContain("Acknowledge findings and continue");
  expect(requestCalls(f.request, "sessions.providerReview.continue")).toHaveLength(0);
});

it("reports a failed status refresh and checks again without replaying an accepted acknowledgment", async () => {
  const f = fixture();
  const firstRefresh = createDeferred<SessionRefreshOutcome>();
  const firstRefreshStarted = createDeferred();
  const secondRefresh = createDeferred<SessionRefreshOutcome>();
  f.refresh
    .mockImplementationOnce(() => {
      firstRefreshStarted.resolve();
      return firstRefresh.promise;
    })
    .mockImplementationOnce(() => secondRefresh.promise);
  await f.open();
  f.click("Acknowledge findings and continue");
  f.outcome.resolve({ runId: "resumed", status: "started" });
  await firstRefreshStarted.promise;
  firstRefresh.resolve({ status: "failed", error: "Disconnected during refresh" });
  await firstRefresh.promise;
  expect(f.container.textContent).toContain(
    "Continuation was requested, but its status could not be refreshed.",
  );
  expect(f.container.textContent).not.toContain("Waiting for the provider to accept it.");
  expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(true);
  expect(f.state.sessionsResult?.sessions[0]?.providerReview).toEqual(row.providerReview);
  f.click("Check continuation status");
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(requestCalls(f.request, "sessions.providerReview.continue")).toHaveLength(1);
  secondRefresh.resolve({ status: "refreshed" });
  await secondRefresh.promise;
  expect(f.container.textContent).toContain("Waiting for the provider to accept it.");
  expect(f.container.textContent).not.toContain("status could not be refreshed");
  expect(f.state.sessionsResult?.sessions[0]?.providerReview).toEqual(row.providerReview);
  expect(requestCalls(f.request, "sessions.providerReview.continue")).toHaveLength(1);
});

it.each(
  (["failed", "timeout", "killed"] as const).flatMap((status) =>
    (["request", "server"] as const).map((runIdentity) => ({ status, runIdentity })),
  ),
)(
  "offers a fresh explicit acknowledgment after the $runIdentity run is canonically $status",
  async ({ status, runIdentity }) => {
    const f = fixture();
    await f.open();
    f.click("Acknowledge findings and continue");
    const first = requireRecord(
      requestCalls(f.request, "sessions.providerReview.continue")[0]?.[1],
      "first acknowledgment",
    );
    const runId =
      runIdentity === "server"
        ? `server-${String(first.idempotencyKey)}`
        : String(first.idempotencyKey);
    f.outcome.resolve({ runId, status: "started" });
    await f.outcome.promise;
    await Promise.resolve();
    await f.refresh.mock.results[0]?.value;
    await Promise.resolve();
    f.state.sessionsResult = sessionsResult(
      [
        {
          ...row,
          lastRunId: runId,
          status,
          hasActiveRun: false,
          activeRunIds: [],
          lastRunError: "Provider authentication failed before acceptance.",
        },
      ],
      2,
    );
    f.paint();
    expect(f.container.textContent).toContain("Continuation was not accepted.");
    expect(f.container.textContent).toContain("Provider authentication failed before acceptance.");
    expect(f.container.textContent).not.toContain("Waiting for the provider to accept it.");
    expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(false);
    expect(requestCalls(f.request, "sessions.providerReview.continue")).toHaveLength(1);
    expect(f.state.sessionsResult?.sessions[0]?.providerReview).toEqual(row.providerReview);
    f.request.mockImplementationOnce((_method, params) => ({
      runId: requireRecord(params, "retry request").idempotencyKey,
      status: "started",
    }));
    f.click("Acknowledge findings and continue");
    const calls = requestCalls(f.request, "sessions.providerReview.continue");
    expect(calls).toHaveLength(2);
    const retry = requireRecord(calls[1]?.[1], "retried acknowledgment");
    expect(retry).toMatchObject({
      sessionKey: row.key,
      sessionId: row.sessionId,
      reviewId: row.providerReview!.id,
    });
    expect(retry.idempotencyKey).not.toBe(first.idempotencyKey);
    await f.outcome.promise;
    await Promise.resolve();
    await f.refresh.mock.results[1]?.value;
  },
);

it.each(["acknowledgment", "refresh"] as const)(
  "waits for the pending %s before offering retry after a matching terminal event",
  async (phase) => {
    const f = fixture();
    const refreshStarted = createDeferred();
    const refresh = createDeferred<SessionRefreshOutcome>();
    f.refresh.mockImplementationOnce(() => {
      refreshStarted.resolve();
      return refresh.promise;
    });
    await f.open();
    f.click("Acknowledge findings and continue");
    const runId = String(
      requireRecord(
        requestCalls(f.request, "sessions.providerReview.continue")[0]?.[1],
        "acknowledgment",
      ).idempotencyKey,
    );
    if (phase === "refresh") {
      f.outcome.resolve({ runId, status: "started" });
      await refreshStarted.promise;
    }
    f.state.sessionsResult = sessionsResult(
      [{ ...row, lastRunId: runId, status: "failed", hasActiveRun: false, activeRunIds: [] }],
      2,
    );
    f.paint();
    expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(true);
    expect(requestCalls(f.request, "sessions.providerReview.continue")).toHaveLength(1);
    f.outcome.resolve({ runId, status: "started" });
    await refreshStarted.promise;
    refresh.resolve({ status: "refreshed" });
    await refresh.promise;
    await Promise.resolve();
    f.paint();
    expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(false);
    expect(f.container.textContent).toContain("Continuation was not accepted.");
    expect(requestCalls(f.request, "sessions.providerReview.continue")).toHaveLength(1);
  },
);

it.each(["missing", "foreign", "active", "active-ids", "running", "read-failure"] as const)(
  "keeps the acknowledged continuation stopped when its terminal proof is %s",
  async (proof) => {
    const f = fixture();
    if (proof === "read-failure") {
      f.refresh.mockResolvedValue({ status: "failed", error: "Could not read current status" });
    }
    await f.open();
    f.click("Acknowledge findings and continue");
    const first = requireRecord(
      requestCalls(f.request, "sessions.providerReview.continue")[0]?.[1],
      "acknowledgment",
    );
    const runId = String(first.idempotencyKey);
    f.outcome.resolve({ runId, status: "started" });
    await f.outcome.promise;
    await Promise.resolve();
    await f.refresh.mock.results[0]?.value;
    await Promise.resolve();
    if (proof !== "read-failure") {
      f.state.sessionsResult = sessionsResult(
        [
          {
            ...row,
            lastRunId: proof === "missing" ? undefined : proof === "foreign" ? "other-run" : runId,
            status: proof === "running" ? "running" : "failed",
            hasActiveRun: proof === "active",
            activeRunIds: proof === "active-ids" ? [runId] : [],
          },
        ],
        2,
      );
    }
    f.paint();
    expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(true);
    f.click("Acknowledge findings and continue");
    expect(requestCalls(f.request, "sessions.providerReview.continue")).toHaveLength(1);
    expect(f.state.sessionsResult?.sessions[0]?.providerReview).toEqual(row.providerReview);
  },
);

it("preserves the same idempotency key after an uncertain transport failure without terminal proof", async () => {
  const f = fixture();
  await f.open();
  f.click("Acknowledge findings and continue");
  const first = requireRecord(
    requestCalls(f.request, "sessions.providerReview.continue")[0]?.[1],
    "first acknowledgment",
  );
  f.outcome.reject(new Error("Connection closed before acknowledgment"));
  await f.outcome.promise.catch(() => {});
  await Promise.resolve();
  f.paint();
  f.click("Acknowledge findings and continue");
  const calls = requestCalls(f.request, "sessions.providerReview.continue");
  expect(calls).toHaveLength(2);
  expect(calls[1]?.[1]).toEqual(first);
  await f.outcome.promise.catch(() => {});
  await Promise.resolve();
});

it.each(["error", "timeout"] as const)(
  "retires a definitive %s acknowledgment key until another explicit click",
  async (status) => {
    const f = fixture();
    await f.open();
    f.click("Acknowledge findings and continue");
    const first = requireRecord(
      requestCalls(f.request, "sessions.providerReview.continue")[0]?.[1],
      "first acknowledgment",
    );
    f.outcome.resolve({ runId: "terminal-continuation", status });
    await f.outcome.promise;
    await Promise.resolve();
    f.paint();
    expect(f.container.textContent).toContain("Continuation was not accepted.");
    expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(false);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(requestCalls(f.request, "sessions.providerReview.continue")).toHaveLength(1);
    expect(f.state.sessionsResult?.sessions[0]?.providerReview).toEqual(row.providerReview);
    f.request.mockImplementationOnce((_method, params) => ({
      runId: requireRecord(params, "retry request").idempotencyKey,
      status: "started",
    }));
    f.click("Acknowledge findings and continue");
    const calls = requestCalls(f.request, "sessions.providerReview.continue");
    expect(calls).toHaveLength(2);
    const retry = requireRecord(calls[1]?.[1], "retried acknowledgment");
    expect(retry).toMatchObject({
      sessionKey: row.key,
      sessionId: row.sessionId,
      reviewId: row.providerReview!.id,
    });
    expect(retry.idempotencyKey).not.toBe(first.idempotencyKey);
    await f.outcome.promise;
    await Promise.resolve();
    await f.refresh.mock.results[0]?.value;
  },
);
