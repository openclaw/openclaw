/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { loadSettings } from "../../app/settings.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { moveQueuedChatMessage } from "./chat-send-actions.ts";
import {
  admitStoredChatComposerQueueItem,
  listStoredChatOutboxes,
  updateStoredChatComposerQueueItems,
} from "./composer-persistence.ts";

const SESSION_KEY = "agent:main";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function queueHost(items: readonly Partial<ChatQueueItem>[], sessionKey = SESSION_KEY) {
  const host = makeChatHost({
    sessionKey,
    connected: false,
    requestHandlers: {},
    agentsList: {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    },
  });
  const unsubscribe = chatOutboxOwner(host).subscribe(host);
  onTestFinished(unsubscribe);
  items.forEach((item, index) => {
    const admitted = admitQueuedMessageForSession(
      host,
      captureChatOutboxAdmission(host, sessionKey, item.agentId),
      {
        id: `queued-${index + 1}`,
        text: `message ${index + 1}`,
        createdAt: 1_000 + index,
        sendState: "waiting-reconnect",
        sessionKey,
        ...item,
      },
    );
    expect(admitted).toBe(true);
  });
  return { host, unsubscribe };
}

/** The drain reads the stored outbox, so this is the delivery order, not a view. */
function storedOrder(host: ReturnType<typeof makeChatHost>): string[] {
  return listStoredChatOutboxes(host).flatMap(({ queue }) => queue.map((item) => item.id));
}

const order = (...indices: number[]) => indices.map((index) => `queued-${index}`);
const move = (host: ReturnType<typeof makeChatHost>, from: number, to: number) =>
  moveQueuedChatMessage(host, `queued-${from}`, `queued-${to}`);

it.each(["state", "storage"] as const)(
  "retains equal-time arrival order across a %s update",
  (update) => {
    const { host } = queueHost([]);
    const owner = chatOutboxOwner(host);
    const admission = captureChatOutboxAdmission(host, host.sessionKey);
    const first: ChatQueueItem = { id: "first", text: "first", createdAt: 1_000 };
    const second: ChatQueueItem = { id: "second", text: "second", createdAt: 1_000 };
    owner.keep(host, admission.scope, first);
    owner.keep(host, admission.scope, second);
    if (update === "state") {
      owner.keep(host, admission.scope, { ...first, sendState: "waiting-model" });
    } else {
      expect(owner.admit(host, admission, second)).toBe("admitted");
    }
    expect(host.chatQueue.map((item) => item.id)).toEqual(["first", "second"]);
    if (update === "storage") {
      expect(owner.admit(host, admission, first)).toBe("admitted");
      expect(storedOrder(host)).toEqual(["first", "second"]);
    }
  },
);

it.each([1_000, 900])(
  "appends a new arrival at time %i after the operator's reordered queue",
  (createdAt) => {
    const { host } = queueHost([{ createdAt: 1_000 }, { createdAt: 1_000 }, { createdAt: 1_000 }]);
    move(host, 3, 1);
    expect(
      chatOutboxOwner(host).admit(host, captureChatOutboxAdmission(host, host.sessionKey), {
        id: "latest",
        text: "latest",
        createdAt,
      }),
    ).toBe("admitted");

    expect(storedOrder(host)).toEqual(["queued-3", "queued-1", "queued-2", "latest"]);
    expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
  },
);

it("reorders the captured inactive outbox after current main defaults change", () => {
  const { host: fixture } = queueHost([{}, {}], "agent:main:main");
  const host = Object.assign(fixture, {
    settings: {
      ...loadSettings(),
      ...fixture.settings,
      gatewayUrl: fixture.settings.gatewayUrl ?? "",
    },
  });
  host.sessionKey = "agent:main:other";
  host.agentsList = {
    defaultId: "main",
    mainKey: "workspace",
    scope: "per-sender",
    agents: [{ id: "main" }],
  };
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
      Array.from({ length: count }, (_, i) => (i === locked ? { sendState: "unconfirmed" } : {})),
    );
    const result = move(host, from, to);
    if (locked === 1) {
      expect(result).toBe("noop");
    }
    move(host, next[0]!, next[1]!);
    expect(storedOrder(host)).toEqual(order(...expected));
    if (locked === 1) {
      expect(host.lastError).toBeNull();
    }
  },
);
it("keeps the equal-time delivery barrier at the tail in place", () => {
  const { host } = queueHost([]);
  for (const id of ["first", "second", "locked"]) {
    expect(
      admitStoredChatComposerQueueItem(host, captureChatOutboxAdmission(host, host.sessionKey), {
        id,
        text: id,
        createdAt: 1_000,
        sendState: id === "locked" ? "unconfirmed" : "waiting-reconnect",
      }),
    ).toBe(true);
  }
  moveQueuedChatMessage(host, "second", "first");
  expect(storedOrder(host).at(-1)).toBe("locked");
});

it("rejects a two-row batch instead of committing a mixed permutation when one row went stale", () => {
  // Reorder rereads storage synchronously; capture stale rows at the CAS boundary
  // to simulate a second tab writing between the original read and commit.
  const { host, unsubscribe } = queueHost([{}, {}, {}]);
  unsubscribe();

  const storedById = (id: string) =>
    listStoredChatOutboxes(host)
      .flatMap(({ queue }) => queue)
      .find((entry) => entry.id === id)!;
  const expectedQueued2 = storedById("queued-2");
  const expectedQueued3 = storedById("queued-3");

  const update = (expected: ChatQueueItem, changes: Partial<ChatQueueItem>) => ({
    expected,
    next: { ...expected, ...changes },
  });
  expect(
    updateStoredChatComposerQueueItems(host, SESSION_KEY, [
      update(expectedQueued2, { sendAttempts: (expectedQueued2.sendAttempts ?? 0) + 1 }),
    ]),
  ).toBe(true);

  const applied = updateStoredChatComposerQueueItems(host, SESSION_KEY, [
    update(expectedQueued3, { orderKey: expectedQueued2.createdAt }),
    update(expectedQueued2, { orderKey: expectedQueued3.createdAt }),
  ]);

  // queued-3 would succeed alone, but its stale sibling rejects the whole batch.
  expect(applied).toBe(false);
  expect(storedOrder(host)).toEqual(order(1, 2, 3));
  expect(storedById("queued-3").orderKey).toBe(expectedQueued3.orderKey);
  expect(storedById("queued-2").sendAttempts).toBe((expectedQueued2.sendAttempts ?? 0) + 1);
});
