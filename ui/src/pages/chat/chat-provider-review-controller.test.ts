// @vitest-environment jsdom
import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { SessionRefreshOutcome } from "../../lib/sessions/session-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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

afterEach(() => vi.restoreAllMocks());

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

function fixture(review: Partial<NonNullable<GatewaySessionRow["providerReview"]>> = {}) {
  const outcome = createDeferred<unknown>();
  const request = makeRequestMock({ "sessions.providerReview.continue": () => outcome.promise });
  const state = makeChatHost({
    client: createTestGatewayClient(request),
    sessionKey: row.key,
    currentSessionId: row.sessionId,
  });
  state.sessionsResult = sessionsResult(
    [{ ...row, providerReview: { ...row.providerReview!, ...review } }],
    1,
  );
  const refresh = vi
    .spyOn(state.sessions, "reconcileMutation")
    .mockResolvedValue({ status: "refreshed" });
  const input = { state, canWrite: true };
  let owner!: ReturnType<typeof createChatProviderReview>;
  let publishSource!: (settle?: boolean) => void;
  const mounted = mountSolid(() => {
    const [source, setSource] = createSignal({ ...input });
    publishSource = (settle = true) => {
      setSource({ ...input });
      if (settle) {
        flush();
      }
    };
    owner = createChatProviderReview({ source, readState: () => state });
    return [
      createComponent(ChatProviderReviewNotice, { owner }),
      createComponent(ChatProviderReviewDialog, { owner }),
    ];
  });
  const { container } = mounted;
  flush();
  const calls = () => requestCalls(request, "sessions.providerReview.continue");
  return {
    state,
    container,
    input,
    owner,
    publishSource,
    calls,
    outcome,
    request,
    refresh,
    click(text: string, settle = true) {
      const button = mounted.getByRole<HTMLButtonElement>("button", { name: text });
      button.click();
      if (settle) {
        flush();
      }
      return button;
    },
    async open() {
      this.click("Review findings");
      await vi.dynamicImportSettled();
      flush();
    },
    async acknowledge() {
      await this.open();
      this.click("Acknowledge findings and continue");
      await waitForSolid(() => expect(calls()).toHaveLength(1));
      return requireRecord(calls()[0]?.[1], "acknowledgment");
    },
    setRow(patch: Partial<GatewaySessionRow>, version = 2) {
      state.sessionsResult = sessionsResult([{ ...row, ...patch }], version);
    },
    expectPaused(disabled: boolean) {
      expect(container.querySelector("button.primary")?.hasAttribute("disabled")).toBe(disabled);
      expect(calls()).toHaveLength(1);
      expect(state.sessionsResult?.sessions[0]?.providerReview).toEqual(row.providerReview);
    },
    text: () => container.textContent,
    unmount: mounted.unmount,
  };
}

async function expectFreshRetry(f: ReturnType<typeof fixture>, first: Record<string, unknown>) {
  f.request.mockImplementationOnce((_method, params) => ({
    runId: requireRecord(params, "retry request").idempotencyKey,
    status: "started",
  }));
  f.click("Acknowledge findings and continue");
  await waitForSolid(() => expect(f.calls()).toHaveLength(2));
  const retry = requireRecord(f.calls()[1]?.[1], "retried acknowledgment");
  expect(retry).toMatchObject({
    sessionKey: row.key,
    sessionId: row.sessionId,
    reviewId: row.providerReview!.id,
  });
  expect(retry.idempotencyKey).not.toBe(first.idempotencyKey);
  await waitForSolid(() => expect(f.text()).toContain("Waiting for the provider to accept it."));
}

function holdRefresh(f: ReturnType<typeof fixture>) {
  const result = createDeferred<SessionRefreshOutcome>();
  const started = createDeferred();
  f.refresh.mockImplementationOnce(() => {
    f.publishSource(false);
    started.resolve();
    return result.promise;
  });
  return { ...result, started: started.promise };
}

it.each(["connection", "session", "review", "disconnection"] as const)(
  "ignores a late continuation outcome after %s changes",
  async (replacement) => {
    const f = fixture();
    await f.acknowledge();
    if (replacement === "connection") {
      f.state.connectionEpoch += 1;
    }
    if (replacement === "session") {
      f.state.currentSessionId = "replacement";
    }
    f.setRow({
      sessionId: replacement === "session" ? "replacement" : row.sessionId,
      providerReview: {
        ...row.providerReview!,
        id: replacement === "review" ? "review-two" : row.providerReview!.id,
      },
    });
    if (replacement === "disconnection") {
      f.unmount();
    } else {
      f.publishSource();
    }
    f.outcome.reject(new Error("Old connection failed"));
    await f.outcome.promise.catch(() => {});
    await Promise.resolve();
    flush();
    expect(f.text()).not.toContain("Old connection failed");
    expect(f.container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(f.state.sessions.reconcileMutation).not.toHaveBeenCalled();
  },
);

it.each([undefined, "Reviewable findings without a continuation."])(
  "keeps stopped findings non-continuable (%s)",
  async (explanation) => {
    const f = fixture({ canContinue: false, explanation, continuationMessage: undefined });
    if (explanation) {
      await f.open();
    }
    expect(f.text()).not.toContain("Acknowledge findings and continue");
    expect(f.calls()).toHaveLength(0);
  },
);

it("rechecks rendered write permission before continuing a reviewed session", async () => {
  const f = fixture();
  await f.open();
  f.input.canWrite = false;
  f.publishSource();
  await f.owner.acknowledge();
  expect(f.calls()).toHaveLength(0);

  f.input.canWrite = true;
  f.publishSource();
  const retiredPermission = f.owner.acknowledge();
  f.input.canWrite = false;
  f.publishSource();
  await retiredPermission;
  expect(f.calls()).toHaveLength(0);

  f.input.canWrite = true;
  f.publishSource();
  const continuation = f.owner.acknowledge();
  await waitForSolid(() => expect(f.calls()).toHaveLength(1));
  f.outcome.resolve({ runId: "resumed", status: "started" });
  await continuation;
});

it("requires explicit safe review, retains the pause, and retries status without replaying ACK", async () => {
  const f = fixture();
  const firstRefresh = holdRefresh(f);
  const secondRefresh = holdRefresh(f);
  expect(f.calls()).toHaveLength(0);
  await f.open();
  const dialog = f.container.querySelector("openclaw-modal-dialog");
  f.publishSource();
  expect(f.container.querySelector("openclaw-modal-dialog")).toBe(dialog);
  expect(f.text()).toContain(row.providerReview!.explanation);
  expect(f.container.querySelector("img")).toBeNull();
  expect(f.container.querySelector("blockquote")?.textContent).toBe(
    row.providerReview!.continuationMessage,
  );
  expect(f.calls()).toHaveLength(0);
  const continueButton = f.click("Acknowledge findings and continue", false);
  continueButton.click();
  await waitForSolid(() => expect(f.calls()).toHaveLength(1));
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
  await firstRefresh.started;
  await waitForSolid(() => expect(f.text()).toContain("Checking continuation status"));
  firstRefresh.resolve({ status: "failed", error: "Disconnected during refresh" });
  await firstRefresh.promise;
  await waitForSolid(() =>
    expect(f.text()).toContain(
      "Continuation was requested, but its status could not be refreshed.",
    ),
  );
  expect(f.text()).not.toContain("Waiting for the provider to accept it.");
  f.expectPaused(true);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  f.click("Check continuation status");
  await secondRefresh.started;
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.calls()).toHaveLength(1);
  secondRefresh.resolve({ status: "refreshed" });
  await secondRefresh.promise;
  await waitForSolid(() => expect(f.text()).toContain("Waiting for the provider to accept it."));
  expect(f.text()).not.toContain("status could not be refreshed");
  f.expectPaused(true);
  f.setRow({ providerReview: undefined });
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
      f.setRow({
        lastRunId: runId,
        status,
        hasActiveRun: false,
        activeRunIds: [],
        lastRunError: "Provider authentication failed before acceptance.",
      });
    }
    f.publishSource();
    await waitForSolid(() => expect(f.text()).toContain("Continuation was not accepted."));
    if (source === "row") {
      expect(f.text()).toContain("Provider authentication failed before acceptance.");
      expect(f.text()).not.toContain("Waiting for the provider to accept it.");
    } else {
      expect(f.refresh).not.toHaveBeenCalled();
    }
    f.expectPaused(false);
    if (source === "row") {
      // A later row may omit the terminal receipt; only an explicit retry retires it.
      f.setRow({}, 3);
      f.publishSource();
      expect(f.text()).toContain("Continuation was not accepted.");
      f.expectPaused(false);
    }
    await expectFreshRetry(f, first);
  },
);

it.each(["acknowledgment", "refresh"] as const)(
  "waits for the pending %s before offering retry after a matching terminal event",
  async (phase) => {
    const f = fixture();
    const refresh = holdRefresh(f);
    const runId = String((await f.acknowledge()).idempotencyKey);
    if (phase === "refresh") {
      f.outcome.resolve({ runId, status: "started" });
      await refresh.started;
    }
    f.setRow({ lastRunId: runId, status: "failed", hasActiveRun: false, activeRunIds: [] });
    f.publishSource();
    f.expectPaused(true);
    f.outcome.resolve({ runId, status: "started" });
    await refresh.started;
    refresh.resolve({ status: "refreshed" });
    await refresh.promise;
    await Promise.resolve();
    f.publishSource();
    await waitForSolid(() => f.expectPaused(false));
    expect(f.text()).toContain("Continuation was not accepted.");
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
    f.setRow({
      lastRunId: proof === "missing" ? undefined : proof === "foreign" ? "other-run" : runId,
      status: proof === "running" ? "running" : "failed",
      hasActiveRun: proof === "active",
      activeRunIds: proof === "active-ids" ? [runId] : [],
    });
    f.publishSource();
    f.expectPaused(true);
    await f.owner.acknowledge();
    expect(f.calls()).toHaveLength(1);
  },
);

it("preserves the same idempotency key after an uncertain transport failure without terminal proof", async () => {
  const f = fixture();
  const first = await f.acknowledge();
  f.outcome.reject(new Error("Connection closed before acknowledgment"));
  await f.outcome.promise.catch(() => {});
  await Promise.resolve();
  f.publishSource();
  await waitForSolid(() => {
    f.expectPaused(false);
    expect(f.text()).toContain("Connection closed before acknowledgment");
  });
  const dialog = f.container.querySelector("openclaw-modal-dialog");
  const retry = createDeferred<unknown>();
  f.request.mockImplementationOnce(() => retry.promise);
  const button = f.click("Acknowledge findings and continue");
  await waitForSolid(() => {
    expect(f.calls()).toHaveLength(2);
    expect(f.text()).not.toContain("Connection closed before acknowledgment");
    expect(button.disabled).toBe(true);
  });
  expect(f.container.querySelector("openclaw-modal-dialog")).toBe(dialog);
  expect(f.container.querySelector("button.primary")).toBe(button);
  const calls = f.calls();
  expect(calls[1]?.[1]).toEqual(first);
  retry.resolve({ runId: "retry-run", status: "started" });
  await waitForSolid(() => expect(f.text()).toContain("Waiting for the provider to accept it."));
});

it("shows rejected status refreshes beside retained controls and clears them during retry", async () => {
  const f = fixture();
  f.refresh.mockRejectedValueOnce(new Error("Status refresh unavailable"));
  await f.acknowledge();
  const dialog = f.container.querySelector("openclaw-modal-dialog");
  f.outcome.resolve({ runId: "accepted-run", status: "started" });
  await waitForSolid(() => {
    expect(f.text()).toContain("Status refresh unavailable");
    expect(f.text()).not.toContain("Waiting for the provider to accept it.");
  });
  const retry = holdRefresh(f);
  const button = f.click("Check continuation status");
  await retry.started;
  await waitForSolid(() => {
    expect(f.text()).not.toContain("Status refresh unavailable");
    expect(f.text()).toContain("Checking continuation status");
    expect(button.disabled).toBe(true);
  });
  expect(f.container.querySelector("openclaw-modal-dialog")).toBe(dialog);
  expect(f.calls()).toHaveLength(1);
  retry.resolve({ status: "refreshed" });
  await waitForSolid(() => expect(f.text()).toContain("Waiting for the provider to accept it."));
});

it.each(["pending", "rejected"] as const)(
  "preserves a %s command failure when reopening the dialog",
  async (phase) => {
    const f = fixture();
    await f.acknowledge();
    if (phase === "rejected") {
      f.outcome.reject(new Error("Continuation unavailable"));
      await waitForSolid(() => expect(f.text()).toContain("Continuation unavailable"));
    }
    f.click("Close");
    await f.open();
    if (phase === "pending") {
      f.outcome.reject(new Error("Continuation unavailable"));
    }
    await waitForSolid(() => expect(f.text()).toContain("Continuation unavailable"));
    expect(f.calls()).toHaveLength(1);
    expect(f.container.querySelector("openclaw-modal-dialog")).not.toBeNull();
  },
);

it("prioritizes terminal owner feedback over a rejected refresh and admits an explicit fresh retry", async () => {
  const f = fixture();
  f.refresh.mockRejectedValueOnce(new Error("Status refresh unavailable"));
  const first = await f.acknowledge();
  f.outcome.resolve({ runId: "accepted-run", status: "started" });
  await waitForSolid(() => expect(f.text()).toContain("Status refresh unavailable"));
  f.setRow({
    lastRunId: "accepted-run",
    status: "failed",
    hasActiveRun: false,
    activeRunIds: [],
    lastRunError: "Provider access revoked",
  });
  f.publishSource();
  await waitForSolid(() => {
    expect(f.text()).toContain("Continuation was not accepted.");
    expect(f.text()).toContain("Provider access revoked");
    expect(f.text()).not.toContain("Status refresh unavailable");
  });
  await expectFreshRetry(f, first);
});

it.each(["acknowledgment", "refresh"] as const)(
  "settles a new review while the retired %s is still pending",
  async (phase) => {
    const f = fixture();
    const oldRefresh = phase === "refresh" ? holdRefresh(f) : null;
    await f.acknowledge();
    if (oldRefresh) {
      f.outcome.resolve({ runId: "old-run", status: "started" });
      await oldRefresh.started;
    }
    f.setRow({ providerReview: { ...row.providerReview!, id: "review-two" } });
    f.publishSource();
    await f.open();
    f.request.mockImplementationOnce(() => ({ runId: "new-run", status: "started" }));
    f.click("Acknowledge findings and continue");
    await waitForSolid(() => expect(f.text()).toContain("Waiting for the provider to accept it."));
    expect(f.calls()).toHaveLength(2);
    expect(f.calls()[1]?.[1]).toMatchObject({ reviewId: "review-two" });
    if (oldRefresh) {
      oldRefresh.resolve({ status: "failed", error: "Retired refresh failed" });
      await oldRefresh.promise;
    } else {
      f.outcome.reject(new Error("Retired request failed"));
      await f.outcome.promise.catch(() => {});
    }
    await waitForSolid(() => {
      expect(f.text()).toContain("Waiting for the provider to accept it.");
      expect(f.text()).not.toContain("Retired");
    });
    await f.owner.acknowledge();
    expect(f.calls()).toHaveLength(2);
  },
);
