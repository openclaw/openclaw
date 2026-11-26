// @vitest-environment node
import { expect, it, vi } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { activeHistory, historyMessage, toolEvent } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

const delivery = vi.hoisted(() => ({
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}));
vi.mock("./chat-history-progress.ts", async (original) => {
  delivery.started.resolve();
  await delivery.release.promise;
  return original<typeof import("./chat-history-progress.ts")>();
});

function retiredRead() {
  const references: WeakRef<object>[] = [];
  const host = makeChatHost({
    requestHandlers: {
      "chat.history": () => {
        const body = historyMessage("assistant", "Retired wire body", { id: "retired", seq: 9 });
        const event = { ...toolEvent("retired-tool"), runId: "retired" };
        const snapshot = activeHistory("retired");
        const run = { ...snapshot.inFlightRun!, events: [event] };
        references.push(...[body, run, event, event.data].map((value) => new WeakRef(value)));
        return { ...snapshot, messages: [body], inFlightRun: run };
      },
    },
  });
  const pending = loadChatHistory(host);
  return { host, references, pending, read: chatHistoryRequests(host).historyRead! };
}

it("releases aborted wire progress before its cold replay module resolves", async () => {
  const retired = retiredRead();
  try {
    await delivery.started.promise;
    expect(retired.references).toHaveLength(4);
    expect(retired.references.map((reference) => reference.deref() !== undefined)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    retired.read.abort();
    await expect(retired.pending).resolves.toBeUndefined();
    expect(retired.host.chatMessages).toEqual([]);
    expect(retired.host.chatRunId).toBeNull();
    expect(retired.host.lastError).toBeNull();
    // Request spies own fulfilled responses; release only those fixture records.
    retired.host.request.mockClear();
    const control = new WeakRef({ unowned: true });
    await collectGarbageForTest();
    expect(control.deref()).toBeUndefined();
    expect(retired.references.map((reference) => reference.deref() !== undefined)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  } finally {
    delivery.release.resolve();
    await Promise.allSettled([retired.pending]);
    await vi.dynamicImportSettled();
  }
  expect(retired.host.chatMessages).toEqual([]);
  expect(retired.host.chatRunId).toBeNull();
  expect(retired.host.lastError).toBeNull();
});
