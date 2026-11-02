/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { subscribeChatOutboxQueue } from "./chat-outbox-queue.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { handlePageGatewayEvent } from "./chat-state-events.test-support.ts";
import { admitStoredChatComposerQueueItemResult } from "./composer-queue-persistence.ts";

const selected = "agent:main:selected";
const foreign = "agent:main:foreign";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pageHost<T extends ReturnType<typeof makeChatHost>>(host: T) {
  const { pane, state } = createTestChatPane({
    client: expectDefined(host.client, "fixture client"),
    sessions: host.sessions,
  });
  onTestFinished(() => pane.disconnectedCallback());
  return Object.assign(state, host);
}

it("publishes a real recovery-owner change to subscribed panes during a foreign event", () => {
  const host = pageHost(makeChatHost({ sessionKey: selected, requestHandlers: {} }));
  const client = expectDefined(host.client, "shared client");
  const peer = pageHost(makeChatHost({ client, sessions: host.sessions, sessionKey: selected }));
  const publications = [host, peer].map((target) => {
    const publish = vi.fn();
    onTestFinished(subscribeChatOutboxQueue(target, publish));
    onTestFinished(chatOutboxOwner(target).subscribe(target));
    return publish;
  });
  onTestFinished(() => host.sessions.dispose());
  const admit = (target: ReturnType<typeof makeChatHost>, id: string, recoveryScope: string) => {
    const item: ChatQueueItem = {
      id,
      text: id,
      sessionKey: selected,
      createdAt: 1,
      sendState: "failed",
      attachmentPayload: { key: `${id}-payload`, recoveryScope, tabId: "fixture-tab" },
      attachmentStorageError: "missing",
    };
    expect(
      admitStoredChatComposerQueueItemResult(
        target,
        captureChatOutboxAdmission(target, selected),
        item,
      ),
    ).toBe("admitted");
  };
  admit(host, "old-owner", client.recoveryScope!);
  const replacement = createTestGatewayClient(async () => ({}));
  vi.spyOn(replacement, "recoveryScope", "get").mockReturnValue("replacement-scope");
  const writer = makeChatHost({ client: replacement, sessionKey: selected });
  onTestFinished(() => writer.sessions.dispose());
  admit(writer, "new-owner", "replacement-scope");
  expect(host.chatQueue.map((row) => row.id)).toEqual(["old-owner"]);
  publications.forEach((publish) => publish.mockClear());

  vi.spyOn(client, "recoveryScope", "get").mockReturnValue("replacement-scope");
  const event: GatewayEventFrame = {
    type: "event",
    event: "sessions.changed",
    payload: { sessionKey: foreign, phase: "message", hasActiveRun: true, updatedAt: 2 },
  };
  handlePageGatewayEvent(host, event, () => false);
  expect(host.chatQueue.map((row) => row.id)).toEqual(["new-owner"]);
  expect(peer.chatQueue.map((row) => row.id)).toEqual(["new-owner"]);
  publications.forEach((publish) => expect(publish).toHaveBeenCalledOnce());
});

it.each(
  ["chat", "session.message", "sessions.changed"].flatMap((event) =>
    [false, true].map((matching) => ({ event, matching })),
  ),
)(
  "publishes only its scoped $event change in a retained pane (matching: $matching)",
  ({ event, matching }) => {
    const host = pageHost(makeChatHost({ sessionKey: selected, requestHandlers: {} }));
    onTestFinished(() => host.sessions.dispose());
    const published = vi.fn();
    onTestFinished(chatRunPresentation(host).subscribe(published));
    let commitFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      commitFrame = callback;
      return 1;
    });
    handlePageGatewayEvent(
      host,
      {
        type: "event",
        event,
        payload: {
          sessionKey: matching ? selected : foreign,
          runId: "event-run",
          ...(event === "chat"
            ? {
                state: "delta",
                deltaText: "Streaming result",
                message: { role: "assistant", content: "Streaming result" },
              }
            : { reason: "label" }),
        },
      },
      () => false,
    );
    expect(published).not.toHaveBeenCalled();
    commitFrame?.(0);
    expect(published).toHaveBeenCalledTimes(matching ? 1 : 0);
    if (matching && event === "chat") {
      expect(host.chatStream).toBe("Streaming result");
      expect(host.chatRunId).toBe("event-run");
    }
    if (!matching) {
      expect(host.chatMessages).toEqual([]);
      expect(host.chatRunId).toBeNull();
    }
  },
);

it.each(["session", "connection"])(
  "retires a queued history refresh after its %s changes",
  async (change) => {
    const pending = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      sessionKey: selected,
      requestHandlers: { "chat.history": () => pending.promise },
    });
    onTestFinished(() => host.sessions.dispose());
    const initial = loadChatHistory(host, { deferBranches: true });
    const refresh = loadChatHistory(host, { deferBranches: true, supersedeInFlight: true });
    if (change === "session") {
      host.sessionKey = foreign;
    } else {
      host.connectionEpoch += 1;
    }
    pending.resolve({ messages: [{ role: "assistant", content: "Retired" }] });
    await Promise.all([initial, refresh]);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
    expect(host.chatMessages).toEqual([]);
  },
);

it("waits for raw history settlement and coalesces custody events into one fresh read", async () => {
  const replacementStarted = createDeferred();
  const reads: Array<{
    pending: ReturnType<typeof createDeferred<ChatHistoryResult>>;
    signal?: AbortSignal;
    params: unknown;
  }> = [];
  const host = pageHost(makeChatHost({ sessionKey: selected, requestHandlers: {} }));
  onTestFinished(() => host.sessions.dispose());
  host.request.mockImplementation((method, params, options) => {
    if (method !== "chat.history") {
      return Promise.resolve({});
    }
    const pending = createDeferred<ChatHistoryResult>();
    reads.push({ pending, signal: options?.signal, params });
    if (reads.length === 2) {
      replacementStarted.resolve();
    }
    return pending.promise;
  });
  const initial = loadChatHistory(host, { deferBranches: true });
  for (let index = 0; index < 3; index += 1) {
    handlePageGatewayEvent(
      host,
      {
        type: "event",
        event: "sessions.changed",
        payload: { sessionKey: selected, reason: "agent.input.settled" },
      },
      () => false,
    );
  }
  const fresh = loadChatHistory(host, { deferBranches: true });
  const response = (content: string): ChatHistoryResult => ({
    messages: [{ role: "assistant", content }],
    sessionId: "current-session",
    sessionInfo: {
      key: selected,
      kind: "direct",
      updatedAt: 4,
      sessionId: "current-session",
      hasActiveRun: false,
      status: "done",
    },
  });
  try {
    expect(reads).toHaveLength(1);
    expect(reads[0]?.signal?.aborted).toBe(false);
    host.chatQueue = [
      { id: "new-custody", sendRunId: "new-run", text: "new", createdAt: 3, sendAttempts: 1 },
    ];
    reads[0]!.pending.resolve(response("Stale history"));
    await replacementStarted.promise;
    expect(reads).toHaveLength(2);
    expect(host.chatMessages).toEqual([]);
    expect(reads[1]?.params).toMatchObject({ inputRunIds: ["new-run"] });
    reads[1]!.pending.resolve(response("Fresh history"));
    await Promise.all([initial, fresh]);
    expect(host.chatMessages).toEqual([{ role: "assistant", content: "Fresh history" }]);
  } finally {
    for (const read of reads) {
      read.pending.resolve(response("Cleanup"));
    }
    await Promise.all([initial, fresh]);
  }
});
