// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  admitStoredChatComposerQueueItem,
  ChatComposerPersistence,
  listStoredChatOutboxes,
  loadChatComposerSnapshot,
  persistChatComposerState,
  removeStoredChatComposerQueueItem,
  restoreChatComposerState,
  updateStoredChatComposerQueueItem,
} from "./composer-persistence.ts";

type ComposerState = Parameters<typeof persistChatComposerState>[0];

function createState(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    sessionKey: "agent:lily:main",
    chatMessage: "",
    chatQueue: [],
    ...overrides,
  };
}

function reconnectItem(id: string, createdAt: number): ChatQueueItem {
  return {
    id,
    text: `message ${id}`,
    createdAt,
    sendRunId: `run-${id}`,
    sendState: "waiting-reconnect",
  };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat composer persistence", () => {
  it("flushes a debounced draft before its owner releases state", () => {
    vi.useFakeTimers();
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "persist during disconnect";
    persistence.schedule();

    persistence.stop();

    expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
      draft: "persist during disconnect",
      queue: [],
    });
  });

  it("keeps debounced draft writes out of durable queue ownership", () => {
    const state = createState({
      chatQueue: [reconnectItem("memory-only", 1)],
    });
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatQueue = [reconnectItem("new-memory-only", 2)];

    persistence.persistChangedState();

    expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
  });

  it("does not erase another split pane draft when its own draft is unchanged", () => {
    const untouchedPane = createState();
    const untouchedPersistence = new ChatComposerPersistence(() => untouchedPane);
    untouchedPersistence.start();

    const editedPane = createState({ chatMessage: "draft from the other pane" });
    expect(persistChatComposerState(editedPane)).toBe(true);

    expect(untouchedPersistence.persistForRouteSwitch()).toBe(true);
    expect(loadChatComposerSnapshot(editedPane, editedPane.sessionKey)?.draft).toBe(
      "draft from the other pane",
    );
  });

  it("does not let an older pane timer overwrite a newer split-pane draft", () => {
    vi.useFakeTimers();
    const olderPane = createState();
    const olderPersistence = new ChatComposerPersistence(() => olderPane);
    olderPersistence.start();
    const newerPane = createState();
    const newerPersistence = new ChatComposerPersistence(() => newerPane);
    newerPersistence.start();

    olderPane.chatMessage = "older draft";
    olderPersistence.schedule();
    newerPane.chatMessage = "newer draft";
    newerPersistence.schedule();
    expect(newerPersistence.persistForRouteSwitch()).toBe(true);

    vi.advanceTimersByTime(200);

    expect(loadChatComposerSnapshot(newerPane, newerPane.sessionKey)?.draft).toBe("newer draft");
    expect(olderPersistence.persistForRouteSwitch()).toBe(false);
    expect(olderPersistence.persistForRouteSwitchResult().status).toBe("conflict");

    olderPane.chatMessage = "newest draft after conflict";
    olderPersistence.schedule();
    vi.advanceTimersByTime(200);

    expect(loadChatComposerSnapshot(olderPane, olderPane.sessionKey)?.draft).toBe(
      "newest draft after conflict",
    );
  });

  it("keeps the later edit when split pane timers flush in natural order", () => {
    vi.useFakeTimers();
    const firstPane = createState();
    const firstPersistence = new ChatComposerPersistence(() => firstPane);
    firstPersistence.start();
    const secondPane = createState();
    const secondPersistence = new ChatComposerPersistence(() => secondPane);
    secondPersistence.start();

    firstPane.chatMessage = "first draft";
    firstPersistence.schedule();
    vi.advanceTimersByTime(10);
    secondPane.chatMessage = "later draft";
    secondPersistence.schedule();

    vi.advanceTimersByTime(190);
    expect(loadChatComposerSnapshot(firstPane, firstPane.sessionKey)?.draft).toBe("first draft");

    vi.advanceTimersByTime(10);
    expect(loadChatComposerSnapshot(secondPane, secondPane.sessionKey)?.draft).toBe("later draft");
  });

  it("does not let an older pane timer resurrect a draft after a newer clear", () => {
    vi.useFakeTimers();
    const initial = createState({ chatMessage: "saved draft" });
    expect(persistChatComposerState(initial)).toBe(true);
    const olderPane = createState({ chatMessage: "saved draft" });
    const olderPersistence = new ChatComposerPersistence(() => olderPane);
    olderPersistence.start();
    const clearingPane = createState({ chatMessage: "saved draft" });
    const clearingPersistence = new ChatComposerPersistence(() => clearingPane);
    clearingPersistence.start();

    olderPane.chatMessage = "stale replacement";
    olderPersistence.schedule();
    clearingPane.chatMessage = "";
    clearingPersistence.schedule();
    expect(clearingPersistence.persistForRouteSwitch()).toBe(true);

    vi.advanceTimersByTime(200);

    expect(loadChatComposerSnapshot(initial, initial.sessionKey)).toBeNull();
  });

  it("persists a delayed global draft to the agent scope captured when typed", () => {
    const state = createState({
      assistantAgentId: "alpha",
      chatMessage: "",
      sessionKey: "global",
    });
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "alpha draft";
    persistence.schedule();

    const beta = createState({
      assistantAgentId: "beta",
      chatMessage: "beta draft",
      sessionKey: "global",
    });
    expect(persistChatComposerState(beta)).toBe(true);
    state.assistantAgentId = "beta";

    expect(persistence.scopeForRouteSwitch()).toEqual({
      sessionKey: "global",
      agentId: "alpha",
    });
    expect(persistence.persistForRouteSwitch()).toBe(true);
    expect(persistence.scopeForRouteSwitch()).toEqual({
      sessionKey: "global",
      agentId: "alpha",
    });
    expect(loadChatComposerSnapshot({ ...state, assistantAgentId: "alpha" }, "global")?.draft).toBe(
      "alpha draft",
    );
    expect(loadChatComposerSnapshot(beta, "global")?.draft).toBe("beta draft");
  });

  it("flushes a route-provided draft applied after persistence starts", () => {
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "draft from route input";
    persistence.schedule();

    expect(persistence.persistForRouteSwitch()).toBe(true);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("draft from route input");
  });

  it("reports when durable outboxes leave no storage slot for a draft", () => {
    const state = createState();
    for (let index = 0; index < 20; index += 1) {
      const sessionKey = `agent:worker-${index}:thread`;
      expect(
        admitStoredChatComposerQueueItem(state, sessionKey, reconnectItem(`scope-${index}`, index)),
      ).toBe(true);
    }

    const draft = createState({
      sessionKey: "agent:draft-owner:thread",
      chatMessage: "keep this in memory when storage is full",
    });
    expect(persistChatComposerState(draft)).toBe(false);
    expect(loadChatComposerSnapshot(draft, draft.sessionKey)).toBeNull();
  });

  it("preserves a newer outbox attempt when a stale pane saves its draft", () => {
    const admitted = reconnectItem("shared", 1);
    const stalePane = createState({ chatQueue: [admitted] });
    expect(admitStoredChatComposerQueueItem(stalePane, stalePane.sessionKey, admitted)).toBe(true);
    const attempted = { ...admitted, sendAttempts: 1 };
    expect(
      updateStoredChatComposerQueueItem(stalePane, stalePane.sessionKey, admitted, attempted),
    ).toBe(true);

    stalePane.chatMessage = "stale pane draft";
    expect(persistChatComposerState(stalePane)).toBe(true);

    expect(loadChatComposerSnapshot(stalePane, stalePane.sessionKey)).toEqual({
      draft: "stale pane draft",
      queue: [
        {
          ...attempted,
          sessionKey: "agent:lily:main",
          agentId: "lily",
        },
      ],
    });
  });

  it("admits distinct same-scope items without whole-queue overwrite", () => {
    const first = reconnectItem("first-pane", 1);
    const second = reconnectItem("second-pane", 2);

    expect(admitStoredChatComposerQueueItem(createState(), "agent:lily:main", first)).toBe(true);
    expect(admitStoredChatComposerQueueItem(createState(), "agent:lily:main", second)).toBe(true);

    expect(
      loadChatComposerSnapshot(createState(), "agent:lily:main")?.queue.map((item) => item.id),
    ).toEqual(["first-pane", "second-pane"]);
  });

  it("rejects conflicting admission of an existing item id", () => {
    const item = reconnectItem("same-id", 1);
    expect(admitStoredChatComposerQueueItem(createState(), "agent:lily:main", item)).toBe(true);

    expect(
      admitStoredChatComposerQueueItem(createState(), "agent:lily:main", {
        ...item,
        text: "different payload",
      }),
    ).toBe(false);
  });

  it("uses item versions to reject stale updates and deletes", () => {
    const state = createState({ chatMessage: "keep this draft" });
    persistChatComposerState(state);
    const original = reconnectItem("versioned", 1);
    const attempted = { ...original, sendAttempts: 1 };
    expect(admitStoredChatComposerQueueItem(state, state.sessionKey, original)).toBe(true);
    expect(updateStoredChatComposerQueueItem(state, state.sessionKey, original, attempted)).toBe(
      true,
    );

    expect(
      updateStoredChatComposerQueueItem(state, state.sessionKey, original, {
        ...original,
        sendAttempts: 2,
      }),
    ).toBe(false);
    expect(removeStoredChatComposerQueueItem(state, state.sessionKey, original.id, original)).toBe(
      false,
    );
    expect(
      removeStoredChatComposerQueueItem(state, state.sessionKey, attempted.id, attempted),
    ).toBe(true);
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
      draft: "keep this draft",
      queue: [],
    });
  });

  it("migrates unresolved bare-main input when the selected agent becomes known", () => {
    const unresolved = createState({ sessionKey: "main" });
    const item = reconnectItem("unresolved-main", 1);
    expect(admitStoredChatComposerQueueItem(unresolved, "main", item)).toBe(true);
    expect(listStoredChatOutboxes(unresolved)).toEqual([
      {
        sessionKey: "global",
        queue: [{ ...item, sessionKey: "global" }],
      },
    ]);

    const resolved = createState({ assistantAgentId: "work", sessionKey: "global" });
    expect(loadChatComposerSnapshot(resolved, "agent:work:main")?.queue).toEqual([
      {
        ...item,
        sessionKey: "agent:work:main",
        agentId: "work",
      },
    ]);
    expect(listStoredChatOutboxes(resolved)).toEqual([
      {
        sessionKey: "global",
        agentId: "work",
        queue: [{ ...item, sessionKey: "global", agentId: "work" }],
      },
    ]);
  });

  it("migrates unresolved global input only to the selected agent", () => {
    const alpha = createState({ assistantAgentId: "alpha", sessionKey: "global" });
    const alphaItem = reconnectItem("alpha-existing", 1);
    expect(admitStoredChatComposerQueueItem(alpha, "global", alphaItem)).toBe(true);

    const unresolved = createState({ sessionKey: "main" });
    const unresolvedItem = reconnectItem("selected-work", 2);
    expect(admitStoredChatComposerQueueItem(unresolved, "main", unresolvedItem)).toBe(true);

    const selectedWork = createState({ assistantAgentId: "work", sessionKey: "global" });
    expect(listStoredChatOutboxes(selectedWork)).toEqual([
      {
        sessionKey: "global",
        agentId: "alpha",
        queue: [{ ...alphaItem, sessionKey: "global", agentId: "alpha" }],
      },
      {
        sessionKey: "global",
        agentId: "work",
        queue: [{ ...unresolvedItem, sessionKey: "global", agentId: "work" }],
      },
    ]);
  });

  it("retains every queued input when shipped alias rows consolidate above the admission cap", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v1:${encodeURIComponent(gatewayUrl)}`;
    const first = Array.from({ length: 50 }, (_, index) =>
      reconnectItem(`canonical-${index}`, index),
    );
    const second = Array.from({ length: 50 }, (_, index) =>
      reconnectItem(`legacy-${index}`, 50 + index),
    );
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "global\u0000agent:work": { queue: first, updatedAt: 2 },
          "agent:work:main\u0000agent:work": { queue: second, updatedAt: 1 },
        },
      }),
    );

    const state = createState({ assistantAgentId: "work", sessionKey: "global" });
    const restored = loadChatComposerSnapshot(state, "global")?.queue ?? [];

    expect(restored).toHaveLength(100);
    expect(restored.map((item) => item.id)).toEqual([...first, ...second].map((item) => item.id));
    expect(listStoredChatOutboxes(state)[0]?.queue).toHaveLength(100);
  });

  it("retains an older alias draft when a newer canonical row only updates the queue", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v1:${encodeURIComponent(gatewayUrl)}`;
    const item = reconnectItem("newer-queue", 2);
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "global\u0000agent:work": { queue: [item], updatedAt: 2 },
          "agent:work:main\u0000agent:work": { draft: "keep this draft", updatedAt: 1 },
        },
      }),
    );

    const state = createState({ assistantAgentId: "work", sessionKey: "global" });
    expect(loadChatComposerSnapshot(state, "global")).toEqual({
      draft: "keep this draft",
      queue: [{ ...item, sessionKey: "global", agentId: "work" }],
    });
    expect(sessionStorage.getItem(storageKey)).not.toContain("agent:work:main");
  });

  it("restores one agent-scoped main outbox before Gateway defaults load", () => {
    const resolved = createState({ assistantAgentId: "work", sessionKey: "global" });
    const item = reconnectItem("offline-reload", 1);
    expect(admitStoredChatComposerQueueItem(resolved, "global", item)).toBe(true);

    const offline = createState({ sessionKey: "main" });
    expect(loadChatComposerSnapshot(offline, "main")?.queue).toEqual([
      { ...item, agentId: "work", sessionKey: "main" },
    ]);
  });

  it("persists an edit after restoring the sole agent draft before defaults load", () => {
    const resolved = createState({
      assistantAgentId: "work",
      chatMessage: "work draft",
      sessionKey: "global",
    });
    expect(persistChatComposerState(resolved)).toBe(true);

    const offline = createState({ sessionKey: "main" });
    expect(restoreChatComposerState(offline)).toBe(true);
    expect(offline.chatMessage).toBe("work draft");
    const persistence = new ChatComposerPersistence(() => offline);
    persistence.start();
    offline.chatMessage = "edited while offline";
    persistence.schedule();
    expect(persistence.persistForRouteSwitch()).toBe(true);

    const reconnected = createState({ assistantAgentId: "work", sessionKey: "global" });
    expect(loadChatComposerSnapshot(reconnected, "global")?.draft).toBe("edited while offline");
  });

  it("restores a shipped qualified-main alias before Gateway defaults load", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v1:${encodeURIComponent(gatewayUrl)}`;
    const item = reconnectItem("legacy-offline-reload", 1);
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "agent:work:main\u0000agent:work": {
            queue: [{ ...item, sessionKey: "agent:work:main", agentId: "work" }],
            updatedAt: 1,
          },
        },
      }),
    );

    const offline = createState({ sessionKey: "main" });
    expect(loadChatComposerSnapshot(offline, "main")?.queue).toEqual([
      { ...item, agentId: "work", sessionKey: "main" },
    ]);
  });

  it("does not guess between agent-scoped main outboxes before defaults load", () => {
    const workItem = reconnectItem("work-offline", 1);
    const otherItem = reconnectItem("other-offline", 2);
    expect(
      admitStoredChatComposerQueueItem(
        createState({ assistantAgentId: "work", sessionKey: "global" }),
        "global",
        workItem,
      ),
    ).toBe(true);
    expect(
      admitStoredChatComposerQueueItem(
        createState({ assistantAgentId: "other", sessionKey: "global" }),
        "global",
        otherItem,
      ),
    ).toBe(true);

    expect(loadChatComposerSnapshot(createState({ sessionKey: "main" }), "main")).toBeNull();
  });

  it("keeps readable migrated composer state when the migration write fails", () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const unresolved = createState({
      chatMessage: "unresolved draft",
      sessionKey: "main",
    });
    const item = reconnectItem("unresolved-with-quota", 1);
    expect(persistChatComposerState(unresolved)).toBe(true);
    expect(admitStoredChatComposerQueueItem(unresolved, "main", item)).toBe(true);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    const resolved = createState({ assistantAgentId: "work", sessionKey: "global" });
    expect(loadChatComposerSnapshot(resolved, "global")).toEqual({
      draft: "unresolved draft",
      queue: [{ ...item, agentId: "work", sessionKey: "global" }],
    });
  });

  it("shares configured bare and agent main aliases with global", () => {
    const state = createState({
      agentsList: { defaultId: "work", mainKey: "workspace" },
      sessionKey: "workspace",
    });
    const bare = reconnectItem("bare-configured", 1);
    const qualified = reconnectItem("qualified-configured", 2);
    expect(admitStoredChatComposerQueueItem(state, "workspace", bare)).toBe(true);
    expect(admitStoredChatComposerQueueItem(state, "agent:work:workspace", qualified)).toBe(true);

    expect(loadChatComposerSnapshot(state, "global")?.queue.map((item) => item.id)).toEqual([
      "bare-configured",
      "qualified-configured",
    ]);
  });

  it("migrates shipped alias rows and consumes legacy tombstones", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v1:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "agent:work:main\u0000agent:work": {
            draft: "legacy draft",
            queue: [
              reconnectItem("removed", 1),
              { ...reconnectItem("kept", 2), sessionKey: "agent:work:main", agentId: "work" },
            ],
            removedQueueItemIds: ["removed"],
            updatedAt: 1,
          },
        },
      }),
    );

    const state = createState({ assistantAgentId: "work", sessionKey: "global" });
    expect(loadChatComposerSnapshot(state, "global")).toEqual({
      draft: "legacy draft",
      queue: [
        {
          ...reconnectItem("kept", 2),
          sessionKey: "global",
          agentId: "work",
        },
      ],
    });
    state.chatMessage = "updated draft";
    persistChatComposerState(state);
    expect(sessionStorage.getItem(storageKey)).not.toContain("removedQueueItemIds");
  });

  it("lists inactive outboxes for explicit reconnect routing", () => {
    const state = createState();
    const older = reconnectItem("inactive-a", 1);
    const newer = reconnectItem("inactive-b", 2);
    expect(admitStoredChatComposerQueueItem(state, "agent:alpha:thread:1", older)).toBe(true);
    expect(admitStoredChatComposerQueueItem(state, "agent:beta:thread:2", newer)).toBe(true);

    expect(listStoredChatOutboxes(state)).toEqual([
      {
        sessionKey: "agent:alpha:thread:1",
        agentId: "alpha",
        queue: [
          {
            ...older,
            sessionKey: "agent:alpha:thread:1",
            agentId: "alpha",
          },
        ],
      },
      {
        sessionKey: "agent:beta:thread:2",
        agentId: "beta",
        queue: [
          {
            ...newer,
            sessionKey: "agent:beta:thread:2",
            agentId: "beta",
          },
        ],
      },
    ]);
  });

  it("restores attachments and Skill Workshop revision metadata", () => {
    const item: ChatQueueItem = {
      ...reconnectItem("rich", 1),
      attachments: [
        {
          id: "att-1",
          mimeType: "image/png",
          fileName: "screen.png",
          dataUrl: "data:image/png;base64,AAA",
        },
      ],
      skillWorkshopRevision: { proposalId: "proposal-1", agentId: "owner" },
    };
    const state = createState();
    expect(admitStoredChatComposerQueueItem(state, state.sessionKey, item)).toBe(true);

    const restored = createState();
    expect(restoreChatComposerState(restored)).toBe(true);
    expect(restored.chatQueue).toEqual([
      { ...item, sessionKey: "agent:lily:main", agentId: "lily" },
    ]);
  });

  it("normalizes interrupted and in-flight states before durable replay", () => {
    const state = createState();
    const sending: ChatQueueItem = {
      ...reconnectItem("sending", 1),
      sendState: "sending",
    };
    const waitingModel: ChatQueueItem = {
      ...reconnectItem("waiting-model", 2),
      sendState: "waiting-model",
    };
    expect(admitStoredChatComposerQueueItem(state, state.sessionKey, sending)).toBe(true);
    expect(admitStoredChatComposerQueueItem(state, state.sessionKey, waitingModel)).toBe(true);

    expect(loadChatComposerSnapshot(state, state.sessionKey)?.queue).toEqual([
      { ...sending, sendState: "waiting-reconnect", sessionKey: state.sessionKey, agentId: "lily" },
      {
        ...waitingModel,
        sendState: "failed",
        sendError: "Chat settings update was interrupted. Review and retry when ready.",
        sessionKey: state.sessionKey,
        agentId: "lily",
      },
    ]);
  });

  it("scopes composer state and outboxes by gateway", () => {
    const state = createState({ chatMessage: "gateway-local draft" });
    persistChatComposerState(state);
    admitStoredChatComposerQueueItem(state, state.sessionKey, reconnectItem("gateway-local", 1));
    const otherGateway = createState({
      settings: { gatewayUrl: "ws://other-gateway.test/control" },
    });

    expect(loadChatComposerSnapshot(otherGateway, otherGateway.sessionKey)).toBeNull();
    expect(listStoredChatOutboxes(otherGateway)).toEqual([]);
  });

  it("evicts draft-only sessions before rejecting an outbox session overflow", () => {
    for (let index = 0; index < 19; index += 1) {
      const sessionKey = `agent:lily:queued:${index}`;
      expect(
        admitStoredChatComposerQueueItem(
          createState({ sessionKey }),
          sessionKey,
          reconnectItem(`queued-${index}`, index),
        ),
      ).toBe(true);
    }
    const draftSessionKey = "agent:lily:draft-only";
    expect(
      persistChatComposerState(
        createState({ chatMessage: "evict this draft first", sessionKey: draftSessionKey }),
      ),
    ).toBe(true);

    const twentiethSessionKey = "agent:lily:queued:19";
    expect(
      admitStoredChatComposerQueueItem(
        createState({ sessionKey: twentiethSessionKey }),
        twentiethSessionKey,
        reconnectItem("queued-19", 19),
      ),
    ).toBe(true);
    expect(loadChatComposerSnapshot(createState(), draftSessionKey)).toBeNull();
    expect(listStoredChatOutboxes(createState())).toHaveLength(20);

    const rejectedDraft = createState({ sessionKey: "agent:lily:rejected-draft" });
    const rejectedPersistence = new ChatComposerPersistence(() => rejectedDraft);
    rejectedPersistence.start();
    rejectedDraft.chatMessage = "keep retrying this draft";
    rejectedPersistence.schedule();
    expect(rejectedPersistence.persistForRouteSwitchResult()).toMatchObject({
      status: "storage-failed",
      expectedDraftRevision: 0,
    });
    expect(loadChatComposerSnapshot(rejectedDraft, rejectedDraft.sessionKey)).toBeNull();

    const overflowSessionKey = "agent:lily:queued:20";
    expect(
      admitStoredChatComposerQueueItem(
        createState({ sessionKey: overflowSessionKey }),
        overflowSessionKey,
        reconnectItem("queued-20", 20),
      ),
    ).toBe(false);
    const outboxes = listStoredChatOutboxes(createState());
    expect(outboxes).toHaveLength(20);
    expect(outboxes.some((outbox) => outbox.sessionKey === overflowSessionKey)).toBe(false);
    expect(outboxes.some((outbox) => outbox.sessionKey === "agent:lily:queued:0")).toBe(true);
  });

  it("keeps readable outboxes available when later storage writes fail", () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const state = createState();
    const item = reconnectItem("readable-after-quota", 1);
    expect(admitStoredChatComposerQueueItem(state, state.sessionKey, item)).toBe(true);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    expect(listStoredChatOutboxes(state)).toEqual([
      {
        sessionKey: "global",
        agentId: "lily",
        queue: [{ ...item, sessionKey: "global", agentId: "lily" }],
      },
    ]);
  });

  it("retries a failed draft write when stopping", () => {
    const storage = createStorageMock();
    const write = storage.setItem.bind(storage);
    let writes = 0;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes === 1) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "retry this write";

    persistence.persistNow();
    persistence.stop();

    expect(writes).toBe(2);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("retry this write");
  });
});
