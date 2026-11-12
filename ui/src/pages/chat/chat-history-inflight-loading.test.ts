// @vitest-environment node
import { expect, it, vi } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import {
  activeHistory,
  createState,
  emit,
  failedHistory,
  historyMessage as message,
} from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";

const delivery = vi.hoisted(() => ({
  attempts: 0,
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}));
vi.mock("./chat-history-inflight.runtime.ts", async (original) => {
  delivery.attempts++;
  delivery.started.resolve();
  await delivery.release.promise;
  return original<typeof import("./chat-history-inflight.runtime.ts")>();
});

function obsoleteRun() {
  const source: { weak?: WeakRef<object> } = {};
  const host = makeChatHost({
    requestHandlers: {
      "chat.history": () => {
        const body = message("assistant", "Retired response", { id: "retired", seq: 9 });
        source.weak = new WeakRef(body);
        return { ...activeHistory("retired"), messages: [body] };
      },
    },
  });
  const pending = loadChatHistory(host);
  return { source, request: host.request, read: chatHistoryRequests(host).historyRead!, pending };
}

it("keeps no-run terminal recovery hot and releases aborted active-run bodies before delivery", async () => {
  const terminal = createState(failedHistory());
  await loadChatHistory(terminal);
  expect(terminal.chatRunError?.summary).toContain("ProjectCloneError");
  expect(delivery.attempts).toBe(0);

  const snapshot = activeHistory("run-live");
  snapshot.inFlightRun!.runId = " run-live ";
  snapshot.inFlightRun!.text = "Restored text";
  snapshot.inFlightRun!.events = [];
  const current = createState(snapshot);
  const emptySnapshot = activeHistory("run-empty");
  emptySnapshot.inFlightRun!.events = [];
  const empty = createState(emptySnapshot);
  const raced = createState(activeHistory("snapshot-run"));
  for (const state of [current, empty, raced]) {
    state.renderLifecycle = { afterCommit: () => () => undefined };
  }
  const retired = obsoleteRun();
  const loading = loadChatHistory(current);
  const emptyLoading = loadChatHistory(empty);
  const racedLoading = loadChatHistory(raced);
  try {
    await delivery.started.promise;
    retired.read.abort();
    await expect(retired.pending).resolves.toBeUndefined();
    retired.request.mockClear();
    const control = new WeakRef({ unowned: true });
    await collectGarbageForTest();
    expect(control.deref()).toBeUndefined();
    expect(retired.source.weak?.deref()).toBeUndefined();

    adoptStartedChatRun(raced, "live-run", 1_000);
    emit(raced, "live-run", { state: "delta", message: message("assistant", "Current stream") });
    delivery.release.resolve();
    await Promise.all([loading, emptyLoading, racedLoading]);
    expect(current).toMatchObject({ chatRunId: "run-live", chatStream: "Restored text" });
    expect(empty).toMatchObject({ chatRunId: "run-empty", chatStream: null });
    expect(raced).toMatchObject({ chatRunId: "live-run", chatStream: "Current stream" });
    expect(delivery.attempts).toBe(1);
  } finally {
    delivery.release.resolve();
    await Promise.allSettled([retired.pending, loading, emptyLoading, racedLoading]);
  }
});
