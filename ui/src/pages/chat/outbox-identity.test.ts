// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  captureChatOutboxRecoveryDestination,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import {
  captureChatOutboxAdmission,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { readQueuedMessageById, removeQueuedMessage, updateQueuedMessage } from "./chat-queue.ts";
import {
  admitStoredChatComposerQueueItem,
  listStoredChatOutboxes,
  loadChatComposerSnapshot,
  persistChatComposerState,
  updateStoredChatComposerQueueItem,
  removeStoredChatComposerQueueItem,
} from "./composer-persistence.ts";

const gatewayUrl = "ws://outbox.test";
const state = {
  settings: { gatewayUrl },
  assistantAgentId: "selected",
  agentsList: { defaultId: "default", mainKey: "workspace", scope: "per-sender" },
  sessionKey: "agent:default:workspace",
  chatMessage: "draft",
  chatQueue: [],
};

function seed(version: 1 | 2 | 3, sessions: Record<string, unknown>) {
  const key = `openclaw.control.chatComposer.v${version}:${encodeURIComponent(gatewayUrl)}`;
  const raw = JSON.stringify({ version, gatewayOwner: gatewayUrl, sessions });
  sessionStorage.setItem(key, raw);
  return { key, raw };
}

function captureDefaultDestination() {
  return captureChatOutboxRecoveryDestination(state, {
    sessionKey: state.sessionKey,
    agentId: "default",
  })!;
}

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => vi.unstubAllGlobals());

describe("outbox submission handoff", () => {
  function admittedSubmission(options = { inline: true, isCurrent: () => true }) {
    const host = { ...state, hello: null, chatQueue: new Array<ChatQueueItem>() };
    expect(
      admitStoredChatComposerQueueItem(host, captureChatOutboxAdmission(host, host.sessionKey), {
        id: "submitted",
        text: "@Alex review this",
        mentions: [{ profileId: "first-recipient", start: 0, end: 5 }],
        createdAt: 1,
        sendRunId: "submitted-run",
        sendAttempts: 0,
        sendState: "waiting-idle",
      }),
    ).toBe(true);
    const stored = listStoredChatOutboxes(host)[0]!.queue[0]!;
    const owner = chatOutboxOwner(host);
    const submission = owner.beginSubmission(host, stored.id, options);
    expect(submission).toBeDefined();
    return { host, stored, owner, submission: submission! };
  }

  it("holds a queued foreground row only while its captured owner is current", () => {
    let current = true;
    const { host, stored, owner, submission } = admittedSubmission({
      inline: false,
      isCurrent: () => current,
    });
    const scope = listStoredChatOutboxes(host)[0]!;
    expect(owner.hasPendingSubmission(scope, stored)).toBe(true);
    expect(readQueuedMessageById(host, stored.id)).toEqual(stored);
    current = false;
    expect(owner.hasPendingSubmission(scope, stored)).toBe(false);
    expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([stored]);
    submission.release();
    expect(readQueuedMessageById(host, stored.id)).toEqual(stored);
  });

  it("retains unsent durable custody and preserves delivery that advances before release", () => {
    const { host, stored, submission } = admittedSubmission();
    expect(readQueuedMessageById(host, stored.id)?.sendState).toBe("submitting");
    expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([stored]);
    expect(
      updateQueuedMessage(host, stored.id, (item) => ({
        ...item,
        sendState: "sending",
        sendAttempts: 1,
      })),
    ).toMatchObject({ sendState: "sending", sendAttempts: 1 });
    submission.release();
    expect(readQueuedMessageById(host, stored.id)).toMatchObject({
      sendState: "sending",
      sendAttempts: 1,
    });
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
      sendState: "waiting-reconnect",
      sendAttempts: 1,
    });
  });

  it.each(["recipient", "position"] as const)(
    "exposes a canonical %s replacement and lets a peer remove it",
    (change) => {
      const { host, stored, submission } = admittedSubmission();
      const peer = { ...host, chatQueue: [...host.chatQueue] };
      const replacement = {
        ...stored,
        ...(change === "recipient"
          ? { mentions: [{ profileId: "new-recipient", start: 0, end: 5 }] }
          : { orderKey: 2 }),
      };
      expect(
        updateStoredChatComposerQueueItem(
          host,
          host.sessionKey,
          stored,
          replacement,
          stored.agentId,
        ),
      ).toBe(true);
      expect(readQueuedMessageById(peer, stored.id)).toEqual(replacement);
      expect(removeQueuedMessage(peer, stored.id)).toBe("removed");
      submission.release();
      expect(readQueuedMessageById(host, stored.id)).toBeNull();
    },
  );

  it("releases the captured session after navigation without claiming a transport attempt", () => {
    const { host, stored, submission } = admittedSubmission();
    host.sessionKey = "agent:default:other";
    submission.release();
    expect(host.chatQueue).toEqual([]);
    expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([stored]);
    host.sessionKey = stored.sessionKey!;
    expect(readQueuedMessageById(host, stored.id)).toEqual(stored);
  });
});

describe("outbox destination identity", () => {
  it.each([
    ["main", "agent:default:workspace", "default"],
    ["workspace", "agent:default:workspace", "default"],
    ["agent:other:main", "agent:other:workspace", "other"],
    ["agent:other:workspace", "agent:other:workspace", "other"],
    ["global", "global", "selected"],
    ["agent:other:global", "agent:other:global", "other"],
    ["agent:bad agent:notes", "agent:bad agent:notes", "bad-agent"],
    [
      "agent:other:matrix:channel:!AbC:example.org",
      "agent:other:matrix:channel:!AbC:example.org",
      "other",
    ],
  ])(
    "retains %s through admission, reload, and a selected-agent change",
    (input, sessionKey, agentId) => {
      const host = { ...state, sessionKey: input };
      expect(persistChatComposerState(host)).toBe(true);
      expect(
        admitStoredChatComposerQueueItem(host, captureChatOutboxAdmission(host, input), {
          id: "queued",
          text: "follow up",
          createdAt: 1,
          sendState: "waiting-idle",
        }),
      ).toBe(true);
      const reloaded = { ...state, assistantAgentId: "different" };
      expect(listStoredChatOutboxes(reloaded)).toEqual([
        {
          sessionKey,
          agentId,
          queue: [
            {
              id: "queued",
              text: "follow up",
              createdAt: 1,
              sendState: "waiting-idle",
              sessionKey,
              agentId,
            },
          ],
        },
      ]);
      expect(loadChatComposerSnapshot(reloaded, sessionKey, agentId)?.draft).toBe("draft");
    },
  );

  it("maps main aliases to global only under configured global scope", () => {
    const host = { ...state, agentsList: { ...state.agentsList, scope: "global" } };
    expect(resolveUiConversationIdentity(host, "main")).toEqual({
      sessionKey: "global",
      agentId: "default",
    });
    expect(resolveUiConversationIdentity(host, "agent:other:workspace")).toEqual({
      sessionKey: "global",
      agentId: "other",
    });
  });

  it("never restores a sole global agent draft into unresolved main", () => {
    expect(persistChatComposerState({ ...state, sessionKey: "global" })).toBe(true);
    expect(loadChatComposerSnapshot({ settings: { gatewayUrl } }, "main")).toBeNull();
  });

  it("does not replay collapsed v2 global data using today's selected agent or main key", () => {
    seed(2, {
      "global\u0000agent:selected": {
        draft: "lost destination",
        draftRevision: 8,
        updatedAt: 8,
        queue: [
          {
            id: "uncertain",
            text: "possibly sent",
            createdAt: 1,
            sessionKey: "global",
            agentId: "selected",
            sendRunId: "original-attempt",
            sendAttempts: 1,
            sendState: "unconfirmed",
          },
        ],
      },
    });
    expect(listStoredChatOutboxes(state)).toEqual([]);
    expect(loadChatComposerSnapshot(state, "global")).toBeNull();
  });
});

describe("outbox browser-state transfer", () => {
  const queue = Array.from({ length: 60 }, (_, i) => ({
    id: `saved-${i}`,
    text: `message ${i}`,
    createdAt: i + 1,
    sendRunId: `attempt-${i}`,
    sendAttempts: i === 0 ? 1 : 0,
    sendState: i === 0 ? "unconfirmed" : "waiting-reconnect",
    attachments: [
      { id: `attachment-${i}`, mimeType: "text/plain", dataUrl: "data:text/plain;base64,YQ==" },
    ],
  }));
  const legacy = {
    draft: "saved objective",
    goalMode: { action: "start" },
    draftRevision: 42,
    updatedAt: 50,
    queue,
  };

  it("preserves v1 literal global separately from qualified main, including IDs and attachments", () => {
    const source = seed(1, {
      "global\u0000agent:selected": legacy,
      "agent:selected:main\u0000agent:selected": { ...legacy, queue: [queue[0]] },
    });
    const outboxes = listStoredChatOutboxes(state);
    expect(outboxes).toHaveLength(2);
    expect(outboxes.map((box) => box.sessionKey)).toEqual(["agent:selected:main", "global"]);
    expect(outboxes.find((box) => box.sessionKey === "global")?.queue).toEqual(
      queue.map((item) => ({ ...item, sessionKey: "global", agentId: "selected" })),
    );
    expect(sessionStorage.getItem(source.key)).toBeNull();
    expect(
      JSON.parse(sessionStorage.getItem(storageTargetForGateway(gatewayUrl).key)!).sessions[
        "global\u0000agent:selected"
      ].draftRevision,
    ).toBe(42);
  });

  it("retains every collapsed entry unsent and restores it only into an explicitly confirmed empty destination", () => {
    const source = seed(2, { "global\u0000agent:selected": legacy });
    const [entry] = readChatOutboxRecovery(state).entries;
    expect(entry?.session).toEqual(legacy);
    expect(listStoredChatOutboxes(state)).toEqual([]);
    const destination = captureChatOutboxRecoveryDestination(state, {
      sessionKey: "agent:selected:review",
      agentId: "selected",
    })!;
    expect(restoreChatOutboxRecovery(state, entry!, destination)).toBe("restored");
    expect(readChatOutboxRecovery(state).entries).toEqual([]);
    const restored = listStoredChatOutboxes(state)[0]!;
    expect(restored.queue).toHaveLength(60);
    expect(
      restored.queue.map((item) => [item.id, item.sendRunId, item.sendAttempts, item.attachments]),
    ).toEqual(queue.map((item) => [item.id, item.sendRunId, item.sendAttempts, item.attachments]));
    expect(restored.queue[0]?.sendState).toBe("unconfirmed");
    expect(restored.queue.slice(1).every((item) => item.sendState === "failed")).toBe(true);
    expect(loadChatComposerSnapshot(state, restored.sessionKey)?.goalMode).toEqual({
      action: "start",
    });
    expect(sessionStorage.getItem(source.key)).toBeNull();
    expect(restoreChatOutboxRecovery(state, entry!, destination)).toBe("conflict");
  });

  it.each(
    ([1, 2, 3] as const).flatMap((version) =>
      ["quota", "noop"].map((failure) => ({ version, failure })),
    ),
  )("keeps v$version source bytes when migration writes $failure", ({ version, failure }) => {
    const source = seed(version, { "main\u0000agent:selected": legacy });
    const write = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      if (failure === "quota") {
        throw new DOMException("quota", "QuotaExceededError");
      }
    });
    expect(readChatOutboxRecovery(state).entries[0]?.session.queue).toHaveLength(60);
    expect(sessionStorage.getItem(source.key)).toBe(source.raw);
    expect(listStoredChatOutboxes(state)).toEqual([]);
    write.mockRestore();
    expect(readChatOutboxRecovery(state).entries).toHaveLength(1);
    expect(sessionStorage.getItem(source.key)).toBeNull();
  });

  it("does not overwrite a newer destination edit or remove its recoverable source", () => {
    seed(2, { "global\u0000agent:selected": legacy });
    const entry = readChatOutboxRecovery(state).entries[0]!;
    const destination = captureDefaultDestination();
    expect(persistChatComposerState({ ...state, chatMessage: "newer input" })).toBe(true);
    expect(restoreChatOutboxRecovery(state, entry, destination)).toBe("conflict");
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("newer input");
    expect(readChatOutboxRecovery(state).entries[0]).toEqual(entry);
  });

  it.each([1, 2, 3] as const)(
    "retains later v%i writes for review after the current namespace exists",
    (version) => {
      const source = seed(version, { "main\u0000agent:selected": legacy });
      const first = readChatOutboxRecovery(state).entries[0]!;
      const later = { ...legacy, draft: "written after downgrade", draftRevision: 99 };
      seed(version, { "main\u0000agent:selected": later });
      const entries = readChatOutboxRecovery(state).entries;
      expect(entries.map((entry) => entry.session.draft)).toEqual([
        first.session.draft,
        "written after downgrade",
      ]);
      expect(listStoredChatOutboxes(state)).toEqual([]);
      expect(sessionStorage.getItem(source.key)).toBeNull();
    },
  );

  it.each([1, 2, 3] as const)(
    "does not reimport an acknowledged v%i source when legacy deletion failed",
    (version) => {
      const source = seed(version, { "main\u0000agent:selected": legacy });
      const remove = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {});
      const entry = readChatOutboxRecovery(state).entries[0]!;
      const destination = captureDefaultDestination();
      expect(restoreChatOutboxRecovery(state, entry, destination)).toBe("restored");
      expect(sessionStorage.getItem(source.key) || null).toBeNull();
      expect(readChatOutboxRecovery(state).entries).toEqual([]);
      expect(listStoredChatOutboxes(state)[0]?.queue).toHaveLength(60);
      remove.mockRestore();
    },
  );

  it("keeps full recovery usable while a later source waits intact for space", () => {
    const target = storageTargetForGateway(gatewayUrl);
    sessionStorage.setItem(
      target.key,
      JSON.stringify({
        version: 4,
        gatewayOwner: gatewayUrl,
        sessions: {},
        recovery: Object.fromEntries(
          Array.from({ length: 80 }, (_, i) => [
            `old-${i}`,
            {
              sourceVersion: 2,
              sourceScopeKey: `old-${i}`,
              session: { draft: `draft ${i}`, draftRevision: i + 1, updatedAt: i + 1 },
            },
          ]),
        ),
      }),
    );
    const source = seed(2, { "global\u0000agent:selected": legacy });
    const recovery = readChatOutboxRecovery(state);
    expect(recovery.blocked).toBe(true);
    expect(recovery.entries).toHaveLength(80);
    expect(sessionStorage.getItem(source.key)).toBe(source.raw);
    const destination = captureDefaultDestination();
    expect(restoreChatOutboxRecovery(state, recovery.entries[0]!, destination)).toBe("restored");
    const resumed = readChatOutboxRecovery(state);
    expect(resumed.blocked).toBe(false);
    expect(resumed.entries).toHaveLength(80);
    expect(resumed.entries.at(-1)?.session).toEqual(legacy);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("draft 0");
    expect(sessionStorage.getItem(source.key)).toBeNull();
  });

  it("leaves recovery intact on failed transfer and current reopen", () => {
    seed(2, { "global\u0000agent:selected": legacy });
    const entry = readChatOutboxRecovery(state).entries[0]!;
    const destination = captureDefaultDestination();
    const source = sessionStorage.getItem(storageTargetForGateway(gatewayUrl).key);
    const write = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(restoreChatOutboxRecovery(state, entry, destination)).toBe("storage-failed");
    expect(sessionStorage.getItem(storageTargetForGateway(gatewayUrl).key)).toBe(source);
    write.mockRestore();
    const reopened = createStorageMock();
    reopened.setItem(storageTargetForGateway(gatewayUrl).key, source!);
    vi.stubGlobal("sessionStorage", reopened);
    expect(readChatOutboxRecovery(state).entries[0]).toEqual(entry);
    expect(listStoredChatOutboxes(state)).toEqual([]);
  });
});

describe("partially preserved legacy identity", () => {
  it("migrates an independently targeted item while retaining the ambiguous bucket draft", () => {
    seed(2, {
      "global\u0000agent:selected": {
        draft: "ambiguous draft",
        updatedAt: 1,
        queue: [
          {
            id: "exact",
            text: "qualified",
            createdAt: 1,
            sessionKey: "agent:other:thread",
            agentId: "other",
            sendAttempts: 1,
            sendRunId: "original",
            sendState: "unconfirmed",
          },
          { id: "ambiguous", text: "collapsed", createdAt: 2, sessionKey: "global" },
        ],
      },
    });
    expect(listStoredChatOutboxes(state)[0]).toMatchObject({
      sessionKey: "agent:other:thread",
      agentId: "other",
      queue: [{ id: "exact", sendRunId: "original", sendAttempts: 1, sendState: "unconfirmed" }],
    });
    expect(readChatOutboxRecovery(state).entries[0]?.session).toMatchObject({
      draft: "ambiguous draft",
      queue: [{ id: "ambiguous" }],
    });
  });
});

describe("captured outbox scope review regressions", () => {
  it("keeps only row data when a durable row becomes a local model wait", () => {
    const host = { ...state, hello: null };
    const admission = captureChatOutboxAdmission(host, host.sessionKey);
    const item = { id: "model-wait", text: "keep target", createdAt: 1 };
    expect(admitStoredChatComposerQueueItem(host, admission, item)).toBe(true);
    const stored = listStoredChatOutboxes(host)[0]!.queue[0]!;

    updateQueuedMessage(host, item.id, (current) => ({ ...current, sendState: "waiting-model" }));

    expect(readQueuedMessageById(host, item.id)).toEqual({ ...stored, sendState: "waiting-model" });
    expect(removeQueuedMessage(host, item.id)).toBe("removed");
    expect(host.chatQueue).toEqual([]);
    expect(readQueuedMessageById(host, item.id)).toBeNull();
  });
  it("verifies the admitted queue target when a notification changes defaults", () => {
    const host = { ...state, agentsList: { ...state.agentsList } };
    const unsubscribe = subscribeStoredChatOutboxChanges(() => {
      host.agentsList.mainKey = "changed";
    });
    try {
      const item = { id: "captured-admission", text: "keep target", createdAt: 1 };
      const admitted = admitStoredChatComposerQueueItem(
        host,
        captureChatOutboxAdmission(host, "main"),
        item,
      );
      expect(listStoredChatOutboxes(host)).toEqual([
        {
          sessionKey: state.sessionKey,
          agentId: "default",
          queue: [{ ...item, sessionKey: state.sessionKey, agentId: "default" }],
        },
      ]);
      expect(admitted).toBe(true);
    } finally {
      unsubscribe();
    }
  });
  it("updates and removes an enumerated captured scope after mainKey changes", () => {
    const initial = {
      ...state,
      sessionKey: "agent:main:main",
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
    };
    expect(
      admitStoredChatComposerQueueItem(
        initial,
        captureChatOutboxAdmission(initial, initial.sessionKey),
        {
          id: "captured",
          text: "keep target",
          createdAt: 1,
        },
      ),
    ).toBe(true);
    const changed = { ...initial, agentsList: { ...initial.agentsList, mainKey: "workspace" } };
    const original = listStoredChatOutboxes(changed)[0]!;
    const item = original.queue[0]!;
    const next = {
      ...item,
      sendState: "unconfirmed" as const,
      sendAttempts: 1,
      sendRunId: "captured-attempt",
    };
    expect(
      updateStoredChatComposerQueueItem(changed, original.sessionKey, item, next, "other"),
    ).toBe(false);
    removeStoredChatComposerQueueItem(changed, original.sessionKey, item.id, item, "other");
    expect(listStoredChatOutboxes(changed)).toEqual([original]);
    expect(
      updateStoredChatComposerQueueItem(changed, original.sessionKey, item, next, original.agentId),
    ).toBe(true);
    expect(listStoredChatOutboxes(changed)[0]).toMatchObject({
      sessionKey: initial.sessionKey,
      queue: [next],
    });
    expect(
      removeStoredChatComposerQueueItem(
        changed,
        original.sessionKey,
        item.id,
        next,
        original.agentId,
      ),
    ).toBe(true);
    expect(listStoredChatOutboxes(changed)).toEqual([]);
  });
  it.each(["bucket", "item"])(
    "quarantines conflicting %s agent facts in legacy state",
    (conflict) => {
      const scopeKey = `agent:main:notes\u0000agent:${conflict === "bucket" ? "work" : "main"}`;
      sessionStorage.setItem(
        storageTargetForGateway(gatewayUrl).legacyKey,
        JSON.stringify({
          version: 1,
          sessions: {
            [scopeKey]: {
              updatedAt: 1,
              queue: [
                {
                  id: "conflicting",
                  text: "preserve me",
                  createdAt: 1,
                  sessionKey: "agent:main:notes",
                  agentId: "work",
                },
              ],
            },
          },
        }),
      );
      expect(listStoredChatOutboxes(state)).toEqual([]);
      expect(readChatOutboxRecovery(state).entries[0]?.session.queue?.[0]).toMatchObject({
        id: "conflicting",
        agentId: "work",
        sessionKey: "agent:main:notes",
      });
    },
  );
});

describe("optimistic local bubble canonical attachment and fail-sticky retention (#156051)", () => {
  it("projects canonical durable row matching by sendRunId even when item ids differ", () => {
    const host = { ...state, hello: null, chatQueue: new Array<ChatQueueItem>() };
    const owner = chatOutboxOwner(host);
    const scope = resolveUiConversationIdentity(host, host.sessionKey);

    owner.keep(host, scope, {
      id: "local-temp-id",
      text: "Optimistic message",
      createdAt: 100,
      sendRunId: "run-xyz-123",
      sendAttempts: 0,
      sendState: "sending",
    });

    const durableRow: ChatQueueItem = {
      id: "canonical-persisted-id",
      text: "Optimistic message",
      createdAt: 100,
      sendRunId: "run-xyz-123",
      sendAttempts: 1,
      sendState: "sending",
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
    };

    expect(
      admitStoredChatComposerQueueItem(
        host,
        captureChatOutboxAdmission(host, scope.sessionKey),
        durableRow,
      ),
    ).toBe(true);

    const snapshot = owner.snapshot(host, scope, [durableRow]);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.id).toBe("canonical-persisted-id");
    expect(snapshot[0]!.sendRunId).toBe("run-xyz-123");

    const all = owner.allItems(host);
    const matching = all.filter((item) => item.sendRunId === "run-xyz-123");
    expect(matching).toHaveLength(1);
    expect(matching[0]!.id).toBe("canonical-persisted-id");
  });

  it("retains local optimistic bubble fail-sticky when neither id nor sendRunId matches durable", () => {
    const host = { ...state, hello: null, chatQueue: new Array<ChatQueueItem>() };
    const owner = chatOutboxOwner(host);
    const scope = resolveUiConversationIdentity(host, host.sessionKey);

    const localItem: ChatQueueItem = {
      id: "local-bubble-1",
      text: "Pending message text",
      createdAt: 200,
      sendRunId: "run-unmatched",
      sendAttempts: 0,
      sendState: "sending",
    };
    owner.keep(host, scope, localItem);

    const otherDurable: ChatQueueItem = {
      id: "durable-other",
      text: "Unrelated persisted message",
      createdAt: 150,
      sendRunId: "run-other",
      sendAttempts: 1,
      sendState: "sending",
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
    };

    const snapshot = owner.snapshot(host, scope, [otherDurable]);
    expect(snapshot).toHaveLength(2);
    expect(snapshot.some((item) => item.id === "local-bubble-1")).toBe(true);
    expect(snapshot.some((item) => item.id === "durable-other")).toBe(true);

    const emptySnapshot = owner.snapshot(host, scope, []);
    expect(emptySnapshot).toHaveLength(1);
    expect(emptySnapshot[0]!.id).toBe("local-bubble-1");
  });

  it("removes aliased queued row when local waiting-model item has provisional id and durable has canonical id with matching sendRunId", () => {
    const host = { ...state, hello: null, chatQueue: new Array<ChatQueueItem>() };
    const owner = chatOutboxOwner(host);
    const scope = resolveUiConversationIdentity(host, host.sessionKey);

    const durableRow: ChatQueueItem = {
      id: "canonical-durable-id",
      text: "Waiting model message",
      createdAt: 100,
      sendRunId: "run-aliased-123",
      sendAttempts: 1,
      sendState: "waiting-model",
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
    };

    expect(
      admitStoredChatComposerQueueItem(
        host,
        captureChatOutboxAdmission(host, scope.sessionKey),
        durableRow,
      ),
    ).toBe(true);

    const localWaiting: ChatQueueItem = {
      id: "provisional-local-id",
      text: "Waiting model message",
      createdAt: 100,
      sendRunId: "run-aliased-123",
      sendAttempts: 1,
      sendState: "waiting-model",
    };
    owner.keep(host, scope, localWaiting);

    const located = owner.locate(host, "provisional-local-id");
    expect(located).toBeDefined();
    expect(located?.item.id).toBe("provisional-local-id");
    expect(located?.durable?.id).toBe("canonical-durable-id");

    const removed = owner.remove(host, "provisional-local-id");
    expect(removed).toBeDefined();

    const outboxes = listStoredChatOutboxes(host);
    const queue = outboxes.find((o) => o.sessionKey === scope.sessionKey)?.queue ?? [];
    expect(queue).toHaveLength(0);
  });

  it("rejects cross-conversation alias lookup and preserves other conversation stored row on removal", () => {
    const host = { ...state, hello: null, chatQueue: new Array<ChatQueueItem>() };
    const owner = chatOutboxOwner(host);
    const scopeA = resolveUiConversationIdentity(host, host.sessionKey);
    const scopeB = { sessionKey: "agent:other-conversation:workspace", agentId: "other" };

    // Durable row belongs to conversation B
    const durableB: ChatQueueItem = {
      id: "stored-b-id",
      text: "Message in conversation B",
      createdAt: 100,
      sendRunId: "shared-run-id-777",
      sendAttempts: 1,
      sendState: "waiting-model",
      sessionKey: scopeB.sessionKey,
      agentId: scopeB.agentId,
    };
    expect(
      admitStoredChatComposerQueueItem(
        host,
        captureChatOutboxAdmission(host, scopeB.sessionKey, scopeB.agentId),
        durableB,
      ),
    ).toBe(true);

    // Provisional local item in conversation A shares the same sendRunId
    const localA: ChatQueueItem = {
      id: "provisional-a-id",
      text: "Message in conversation A",
      createdAt: 100,
      sendRunId: "shared-run-id-777",
      sendAttempts: 0,
      sendState: "sending",
    };
    owner.keep(host, scopeA, localA);

    // locate in conversation A must NOT select durableB from conversation B
    const located = owner.locate(host, "provisional-a-id");
    expect(located).toBeDefined();
    expect(located?.scope.sessionKey).toBe(scopeA.sessionKey);
    expect(located?.durable).toBeUndefined();

    // remove in conversation A must NOT delete durableB from conversation B
    owner.remove(host, "provisional-a-id");
    const outboxes = listStoredChatOutboxes(host);
    const queueB = outboxes.find((o) => o.sessionKey === scopeB.sessionKey)?.queue ?? [];
    expect(queueB).toHaveLength(1);
    expect(queueB[0]!.id).toBe("stored-b-id");
  });

  it("updates aliased queued row in durable storage using canonical stored row", () => {
    const host = { ...state, hello: null, chatQueue: new Array<ChatQueueItem>() };
    const owner = chatOutboxOwner(host);
    const scope = resolveUiConversationIdentity(host, host.sessionKey);

    const durableRow: ChatQueueItem = {
      id: "canonical-durable-id",
      text: "Queued message",
      createdAt: 100,
      sendRunId: "run-update-alias-888",
      sendAttempts: 1,
      sendState: "waiting-model",
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
    };
    expect(
      admitStoredChatComposerQueueItem(
        host,
        captureChatOutboxAdmission(host, scope.sessionKey),
        durableRow,
      ),
    ).toBe(true);

    const localWaiting: ChatQueueItem = {
      id: "provisional-local-id",
      text: "Queued message",
      createdAt: 100,
      sendRunId: "run-update-alias-888",
      sendAttempts: 1,
      sendState: "waiting-model",
    };
    owner.keep(host, scope, localWaiting);

    // update called with provisional ID updates durable storage successfully
    const results = owner.update(host, [
      {
        id: "provisional-local-id",
        update: (item) => ({ ...item, sendState: "failed", sendError: "Network failure" }),
      },
    ]);
    expect(results).toBeDefined();
    expect(results?.[0]?.sendState).toBe("failed");
    expect(results?.[0]?.id).toBe("canonical-durable-id");

    // verify durable storage has the updated state
    const outboxes = listStoredChatOutboxes(host);
    const queue = outboxes.find((o) => o.sessionKey === scope.sessionKey)?.queue ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe("canonical-durable-id");
    expect(queue[0]!.sendState).toBe("failed");
    expect(queue[0]!.sendError).toBe("Network failure");
  });

  it("does not suppress local queued item in conversation A when conversation B has a durable row with the same sendRunId during snapshot, reconcile, or allItems", () => {
    const host = { ...state, hello: null, chatQueue: new Array<ChatQueueItem>() };
    const owner = chatOutboxOwner(host);
    const scopeA = resolveUiConversationIdentity(host, host.sessionKey);
    const scopeB = { sessionKey: "agent:other-conversation:workspace", agentId: "other" };

    const sharedRunId = "cross-scope-collision-run-id";

    // Conversation B has an admitted durable row
    const durableB: ChatQueueItem = {
      id: "durable-b-row",
      text: "Message in B",
      createdAt: 100,
      sendRunId: sharedRunId,
      sendAttempts: 1,
      sendState: "waiting-model",
      sessionKey: scopeB.sessionKey,
      agentId: scopeB.agentId,
    };
    expect(
      admitStoredChatComposerQueueItem(
        host,
        captureChatOutboxAdmission(host, scopeB.sessionKey, scopeB.agentId),
        durableB,
      ),
    ).toBe(true);

    // Conversation A has a local pending item with the same sendRunId
    const localA: ChatQueueItem = {
      id: "local-a-item",
      text: "Message in A",
      createdAt: 200,
      sendRunId: sharedRunId,
      sendAttempts: 0,
      sendState: "sending",
    };
    owner.keep(host, scopeA, localA);

    // 1. Snapshot in conversation A must retain localA and not drop it due to conversation B's durable row
    const snapshotA = owner.snapshot(host, scopeA);
    expect(snapshotA).toHaveLength(1);
    expect(snapshotA[0]!.id).toBe("local-a-item");
    expect(snapshotA[0]!.text).toBe("Message in A");

    // 2. allItems must include localA alongside durableB without suppressing localA
    const all = owner.allItems(host);
    expect(all.some((item) => item.id === "local-a-item")).toBe(true);
    expect(all.some((item) => item.id === "durable-b-row")).toBe(true);
    expect(all).toHaveLength(2);
  });
});
