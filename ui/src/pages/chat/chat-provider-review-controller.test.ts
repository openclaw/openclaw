// @vitest-environment jsdom
import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { SessionRefreshOutcome } from "../../lib/sessions/session-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  makeChatHost,
  makeRequestMock,
  requestCalls,
  requireRecord,
} from "./chat-host.test-support.ts";
import {
  createChatProviderReview,
  ChatProviderReviewNotice,
  ChatProviderReviewDialog,
} from "./chat-provider-review-controller.tsx";

const containers: { element: HTMLElement; dispose: () => void }[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) {
    container.dispose();
    container.element.remove();
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
  document.body.append(container);
  const input = { state, canWrite: true };
  let owner!: ReturnType<typeof createChatProviderReview>;
  let publishSource = () => flush();
  const mounted = mountSolid(
    () => {
      const [source, setSource] = createSignal({ ...input });
      publishSource = () => {
        setSource({ ...input });
        flush();
      };
      owner = createChatProviderReview({ source, readState: () => state });
      return [
        createComponent(ChatProviderReviewNotice, { owner }),
        createComponent(ChatProviderReviewDialog, { owner }),
      ];
    },
    { container },
  );
  containers.push({ element: container, dispose: mounted.unmount });
  flush();
  const click = (text: string, settle = true) => {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    expect(button, text).toBeDefined();
    button!.click();
    if (settle) {
      flush();
    }
    return button!;
  };
  const open = async () => {
    click("Review findings");
    await vi.dynamicImportSettled();
    flush();
  };
  const calls = () => requestCalls(request, "sessions.providerReview.continue");
  const acknowledge = async () => {
    await open();
    click("Acknowledge findings and continue");
    return requireRecord(calls()[0]?.[1], "acknowledgment");
  };
  return {
    state,
    container,
    input,
    owner,
    publishSource,
    click,
    open,
    acknowledge,
    calls,
    outcome,
    request,
    refresh,
    unmount: mounted.unmount,
  };
}

async function expectFreshRetry(f: ReturnType<typeof fixture>, first: Record<string, unknown>) {
  f.request.mockImplementationOnce((_method, params) => ({
    runId: requireRecord(params, "retry request").idempotencyKey,
    status: "started",
  }));
  f.click("Acknowledge findings and continue");
  expect(f.calls()).toHaveLength(2);
  const retry = requireRecord(f.calls()[1]?.[1], "retried acknowledgment");
  expect(retry).toMatchObject({
    sessionKey: row.key,
    sessionId: row.sessionId,
    reviewId: row.providerReview!.id,
  });
  expect(retry.idempotencyKey).not.toBe(first.idempotencyKey);
  await f.outcome.promise;
  await Promise.resolve();
  await f.refresh.mock.results.at(-1)?.value;
}

it.each(["connection", "session", "review", "disconnection"] as const)(
  "ignores a late continuation outcome after %s changes",
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
    if (replacement === "disconnection") {
      f.unmount();
    } else {
      f.publishSource();
    }
    f.outcome.reject(new Error("Old connection failed"));
    await f.outcome.promise.catch(() => {});
    await Promise.resolve();
    flush();
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
  expect(f.calls()).toHaveLength(0);
});

it("rechecks rendered write permission before continuing a reviewed session", async () => {
  const f = fixture();
  await f.open();
  f.input.canWrite = false;
  f.publishSource();
  await f.owner.acknowledge();
  expect(f.calls()).toHaveLength(0);

  f.input.canWrite = true;
  f.publishSource();
  const continuation = f.owner.acknowledge();
  expect(f.calls()).toHaveLength(1);
  f.outcome.resolve({ runId: "resumed", status: "started" });
  await continuation;
});

it("requires explicit safe review, retains the pause, and retries status without replaying ACK", async () => {
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
  expect(f.calls()).toHaveLength(0);
  await f.open();
  const dialog = f.container.querySelector("openclaw-modal-dialog");
  f.publishSource();
  expect(f.container.querySelector("openclaw-modal-dialog")).toBe(dialog);
  expect(f.container.textContent).toContain(row.providerReview!.explanation);
  expect(f.container.querySelector("img")).toBeNull();
  expect(f.container.querySelector("blockquote")?.textContent).toBe(
    row.providerReview!.continuationMessage,
  );
  expect(f.calls()).toHaveLength(0);
  const continueButton = f.click("Acknowledge findings and continue", false);
  continueButton.click();
  flush();
  f.click("Requesting continuation…");
  const calls = f.calls();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[1]).toEqual({
    sessionKey: row.key,
    agentId: "main",
    sessionId: row.sessionId,
    reviewId: row.providerReview!.id,
    idempotencyKey: expect.any(String),
  });
  f.outcome.resolve({ runId: "resumed", status: "started" });
  await firstRefreshStarted.promise;
  firstRefresh.resolve({ status: "failed", error: "Disconnected during refresh" });
  await firstRefresh.promise;
  flush();
  expect(f.container.textContent).toContain(
    "Continuation was requested, but its status could not be refreshed.",
  );
  expect(f.container.textContent).not.toContain("Waiting for the provider to accept it.");
  expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(true);
  expect(f.state.sessionsResult?.sessions[0]?.providerReview).toEqual(row.providerReview);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  f.click("Check continuation status");
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.calls()).toHaveLength(1);
  secondRefresh.resolve({ status: "refreshed" });
  await secondRefresh.promise;
  flush();
  expect(f.container.textContent).toContain("Waiting for the provider to accept it.");
  expect(f.container.textContent).not.toContain("status could not be refreshed");
  expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(true);
  expect(f.state.sessionsResult?.sessions[0]?.providerReview).toEqual(row.providerReview);
  expect(f.calls()).toHaveLength(1);
  f.state.sessionsResult = sessionsResult([{ ...row, providerReview: undefined }], 2);
  f.publishSource();
  expect(f.container.querySelector(".chat-provider-review")).toBeNull();
  expect(f.container.querySelector("openclaw-modal-dialog")).toBeNull();
});

it.each([
  { source: "row", status: "failed", runIdentity: "request" },
  { source: "row", status: "timeout", runIdentity: "server" },
  { source: "row", status: "killed", runIdentity: "server" },
  { source: "ack", status: "error", runIdentity: "server" },
  { source: "ack", status: "timeout", runIdentity: "server" },
] as const)(
  "requires a fresh explicit acknowledgment after $source reports $status ($runIdentity)",
  async ({ source, status, runIdentity }) => {
    const f = fixture();
    const first = await f.acknowledge();
    const runId =
      runIdentity === "server"
        ? `server-${String(first.idempotencyKey)}`
        : String(first.idempotencyKey);
    f.outcome.resolve({ runId, status: source === "ack" ? status : "started" });
    await f.outcome.promise;
    await Promise.resolve();
    if (source === "row") {
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
    }
    f.publishSource();
    expect(f.container.textContent).toContain("Continuation was not accepted.");
    if (source === "row") {
      expect(f.container.textContent).toContain(
        "Provider authentication failed before acceptance.",
      );
      expect(f.container.textContent).not.toContain("Waiting for the provider to accept it.");
    } else {
      expect(f.refresh).not.toHaveBeenCalled();
    }
    expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(false);
    expect(f.calls()).toHaveLength(1);
    expect(f.state.sessionsResult?.sessions[0]?.providerReview).toEqual(row.providerReview);
    if (source === "row") {
      // A later row may omit the terminal receipt; only an explicit retry retires it.
      f.state.sessionsResult = sessionsResult([{ ...row }], 3);
      f.publishSource();
      expect(f.container.textContent).toContain("Continuation was not accepted.");
      expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(false);
    }
    await expectFreshRetry(f, first);
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
    const runId = String((await f.acknowledge()).idempotencyKey);
    if (phase === "refresh") {
      f.outcome.resolve({ runId, status: "started" });
      await refreshStarted.promise;
    }
    f.state.sessionsResult = sessionsResult(
      [{ ...row, lastRunId: runId, status: "failed", hasActiveRun: false, activeRunIds: [] }],
      2,
    );
    f.publishSource();
    expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(true);
    expect(f.calls()).toHaveLength(1);
    f.outcome.resolve({ runId, status: "started" });
    await refreshStarted.promise;
    refresh.resolve({ status: "refreshed" });
    await refresh.promise;
    await Promise.resolve();
    f.publishSource();
    expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(false);
    expect(f.container.textContent).toContain("Continuation was not accepted.");
    expect(f.calls()).toHaveLength(1);
  },
);

it.each(["missing", "foreign", "active", "active-ids", "running"] as const)(
  "keeps the acknowledged continuation stopped when its terminal proof is %s",
  async (proof) => {
    const f = fixture();
    const first = await f.acknowledge();
    const runId = String(first.idempotencyKey);
    f.outcome.resolve({ runId, status: "started" });
    await f.outcome.promise;
    await Promise.resolve();
    await f.refresh.mock.results[0]?.value;
    await Promise.resolve();
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
    f.publishSource();
    expect(f.container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(true);
    f.click("Acknowledge findings and continue");
    expect(f.calls()).toHaveLength(1);
    expect(f.state.sessionsResult?.sessions[0]?.providerReview).toEqual(row.providerReview);
  },
);

it("preserves the same idempotency key after an uncertain transport failure without terminal proof", async () => {
  const f = fixture();
  const first = await f.acknowledge();
  f.outcome.reject(new Error("Connection closed before acknowledgment"));
  await f.outcome.promise.catch(() => {});
  await Promise.resolve();
  f.publishSource();
  f.click("Acknowledge findings and continue");
  const calls = f.calls();
  expect(calls).toHaveLength(2);
  expect(calls[1]?.[1]).toEqual(first);
  await f.outcome.promise.catch(() => {});
  await Promise.resolve();
});
