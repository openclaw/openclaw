/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { loadSettings } from "../../app/settings.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { moveQueuedChatMessage } from "./chat-send-actions.ts";
import {
  admitStoredChatComposerQueueItemResult,
  updateStoredChatComposerQueueItems,
} from "./composer-queue-persistence.ts";

const SESSION_KEY = "agent:main";
const agentsList = makeBootRoster();
const queued = (id: string, createdAt = 1_000): ChatQueueItem => ({ id, text: id, createdAt });
const admission = (host: ReturnType<typeof makeChatHost>, agentId?: string) =>
  captureChatOutboxAdmission(host, host.sessionKey, agentId);

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function queueHost(items: readonly Partial<ChatQueueItem>[], sessionKey = SESSION_KEY) {
  const host = makeChatHost({
    sessionKey,
    connected: false,
    requestHandlers: {},
    agentsList,
  });
  const unsubscribe = chatOutboxOwner(host).subscribe(host);
  onTestFinished(unsubscribe);
  items.forEach((item, index) =>
    expect(
      admitQueuedMessageForSession(host, admission(host, item.agentId), {
        ...queued(`queued-${index + 1}`, 1_000 + index),
        sendState: "waiting-reconnect",
        sessionKey,
        ...item,
      }),
    ).toBe(true),
  );
  return { host, unsubscribe };
}

const storedOrder = (host: ReturnType<typeof makeChatHost>) =>
  listStoredChatOutboxes(host).flatMap(({ queue }) => queue.map((item) => item.id));

const order = (...indices: number[]) => indices.map((index) => `queued-${index}`);
const move = (host: ReturnType<typeof makeChatHost>, from: number, to: number) =>
  moveQueuedChatMessage(host, `queued-${from}`, `queued-${to}`);

it.each(["state", "storage"] as const)(
  "retains equal-time arrival order across a %s update",
  (update) => {
    const { host } = queueHost([]);
    const owner = chatOutboxOwner(host);
    const captured = admission(host);
    const first = queued("first");
    const second = queued("second");
    owner.keep(host, captured.scope, first);
    owner.keep(host, captured.scope, second);
    if (update === "state") {
      owner.keep(host, captured.scope, { ...first, sendState: "waiting-model" });
    } else {
      expect(owner.admit(host, captured, second)).toBe("admitted");
    }
    expect(host.chatQueue.map((item) => item.id)).toEqual(["first", "second"]);
    if (update === "storage") {
      expect(owner.admit(host, captured, first)).toBe("admitted");
      expect(storedOrder(host)).toEqual(["first", "second"]);
    }
  },
);

it.each([1_000, 900])("appends arrival at %i after the reordered queue", (createdAt) => {
  const { host } = queueHost([{ createdAt: 1_000 }, { createdAt: 1_000 }, { createdAt: 1_000 }]);
  move(host, 3, 1);
  expect(chatOutboxOwner(host).admit(host, admission(host), queued("latest", createdAt))).toBe(
    "admitted",
  );

  expect(storedOrder(host)).toEqual(["queued-3", "queued-1", "queued-2", "latest"]);
  expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
});

it("reorders the captured inactive outbox after current main defaults change", () => {
  const { host } = queueHost([{}, {}], "agent:main:main");
  const gatewayUrl = host.settings.gatewayUrl ?? "";
  host.settings = { ...loadSettings(), ...host.settings, gatewayUrl };
  host.sessionKey = "agent:main:other";
  host.agentsList = { ...agentsList, mainKey: "workspace" };
  expect(move(host, 2, 1)).toBe("moved");
  expect(listStoredChatOutboxes(host)).toMatchObject([
    {
      sessionKey: "agent:main:main",
      agentId: "main",
      queue: [{ id: "queued-2" }, { id: "queued-1" }],
    },
  ]);
});

it.each(["ordered", "equal-time", "write-failure"] as const)(
  "persists a reorder atomically through reload (%s)",
  (scenario) => {
    const { host, unsubscribe } = queueHost(
      Array.from({ length: 3 }, () => (scenario === "equal-time" ? { createdAt: 1_000 } : {})),
    );
    const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
    let writes = 0;
    // A per-row writer would leave a partial permutation after the first write.
    vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
      if (++writes > 1 || scenario === "write-failure") {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      originalSetItem(key, value);
    });
    move(host, 3, 1);
    const expected = scenario === "write-failure" ? order(1, 2, 3) : order(3, 1, 2);
    expect(writes).toBe(1);
    expect(storedOrder(host)).toEqual(expected);
    expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
    if (scenario === "write-failure") {
      expect(host.lastError).not.toBeNull();
    } else {
      expect(host.lastError).toBeNull();
    }
    unsubscribe();
    expect(
      storedOrder(makeChatHost({ sessionKey: SESSION_KEY, connected: false, requestHandlers: {} })),
    ).toEqual(expected);
  },
);

it.each([
  { barrier: "head", count: 3, locked: 0, from: 1, to: 3, next: [3, 2], expected: [1, 3, 2] },
  { barrier: "middle", count: 4, locked: 1, from: 4, to: 1, next: [4, 3], expected: [1, 2, 4, 3] },
])(
  "keeps the delivery barrier at the $barrier in place",
  ({ count, locked, from, to, next, expected }) => {
    const { host } = queueHost(
      Array.from({ length: count }, (_, i) =>
        i === locked ? { sendState: "waiting-reconnect", sendAttempts: 1 } : {},
      ),
    );
    const result = move(host, from, to);
    move(host, next[0]!, next[1]!);
    expect(storedOrder(host)).toEqual(order(...expected));
    if (locked === 1) {
      expect({ result, error: host.lastError }).toEqual({ result: "noop", error: null });
    }
  },
);
it("keeps the equal-time delivery barrier at the tail in place", () => {
  const { host } = queueHost([]);
  for (const id of ["first", "second", "locked"]) {
    expect(
      admitStoredChatComposerQueueItemResult(host, admission(host), {
        ...queued(id),
        sendState: "waiting-reconnect",
        sendAttempts: id === "locked" ? 1 : 0,
      }),
    ).toBe("admitted");
  }
  moveQueuedChatMessage(host, "second", "first");
  expect(storedOrder(host).at(-1)).toBe("locked");
});

it("rejects a two-row batch instead of committing a mixed permutation when one row went stale", () => {
  // Simulate a second tab writing between the original read and the CAS commit.
  const { host, unsubscribe } = queueHost([{}, {}, {}]);
  unsubscribe();

  const storedQueue = () => listStoredChatOutboxes(host)[0]!.queue;
  const expectedQueued2 = storedQueue()[1]!;
  const expectedQueued3 = storedQueue()[2]!;

  const update = (expected: ChatQueueItem, changes: Partial<ChatQueueItem>) => ({
    expected,
    next: { ...expected, ...changes },
  });
  expect(
    updateStoredChatComposerQueueItems(host, SESSION_KEY, [
      update(expectedQueued2, { sendAttempts: (expectedQueued2.sendAttempts ?? 0) + 1 }),
    ]),
  ).toBe(true);

  expect(
    updateStoredChatComposerQueueItems(host, SESSION_KEY, [
      update(expectedQueued3, { orderKey: expectedQueued2.createdAt }),
      update(expectedQueued2, { orderKey: expectedQueued3.createdAt }),
    ]),
  ).toBe(false);
  expect(storedOrder(host)).toEqual(order(1, 2, 3));
  expect(storedQueue()[2]!.orderKey).toBe(expectedQueued3.orderKey);
  expect(storedQueue()[1]!.sendAttempts).toBe((expectedQueued2.sendAttempts ?? 0) + 1);
});
