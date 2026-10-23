// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { outboxStorageScope } from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination as captureDestination,
  readChatOutboxRecovery as readRecovery,
  restoreChatOutboxRecovery as restoreRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import { listStoredChatOutboxes as listOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import {
  captureChatOutboxAdmission as captureAdmission,
  storageTargetForComposer,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges as subscribeOutbox,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  readQueuedMessageById as readQueued,
  removeQueuedMessage as removeQueued,
  updateQueuedMessage as updateQueued,
} from "./chat-queue.ts";
import {
  loadChatComposerState as loadComposer,
  persistChatComposerState as persistComposer,
} from "./composer-draft-storage.ts";
import {
  admitStoredChatComposerQueueItemResult as admitQueueItem,
  updateStoredChatComposerQueueItems as updateQueueItems,
} from "./composer-queue-persistence.ts";

const gatewayUrl = "ws://outbox.test";
const globalScope = "global\u0000agent:selected";
const mainScope = "main\u0000agent:selected";
const qualifiedScope = "agent:selected:main\u0000agent:selected";
const state = {
  settings: { gatewayUrl },
  connected: true,
  client: { recoveryScope: "credential", recoveryScopeReady: true },
  assistantAgentId: "selected",
  agentsList: { defaultId: "default", mainKey: "workspace", scope: "per-sender" },
  sessionKey: "agent:default:workspace",
  chatMessage: "draft",
  chatQueue: new Array<ChatQueueItem>(),
};

function seed(
  version: 1 | 2 | 3 | 4,
  sessions: Record<string, unknown>,
  key = `openclaw.control.chatComposer.v${version}:${encodeURIComponent(gatewayUrl)}`,
  recovery?: Record<string, unknown>,
) {
  const raw = JSON.stringify({ version, gatewayOwner: gatewayUrl, sessions, recovery });
  sessionStorage.setItem(key, raw);
  return { key, raw };
}

function destinationFor(sessionKey = state.sessionKey, agentId = "default") {
  return captureDestination(state, { sessionKey, agentId })!;
}

function queueItem(overrides: Partial<ChatQueueItem> = {}): ChatQueueItem {
  return { id: "queued", text: "keep target", createdAt: 1, ...overrides };
}

function admit(host: typeof state, item: ChatQueueItem) {
  expect(admitQueueItem(host, captureAdmission(host, host.sessionKey), item)).toBe("admitted");
}

function expectedOutbox(item: ChatQueueItem, sessionKey = state.sessionKey, agentId = "default") {
  const identity = { sessionKey, agentId };
  const queue = [{ ...item, storageScope: outboxStorageScope(state), ...identity }];
  return { ...identity, queue };
}

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => vi.unstubAllGlobals());

function admittedSubmission(options = { inline: true, isCurrent: () => true }) {
  const host = { ...state, hello: null, chatQueue: new Array<ChatQueueItem>() };
  admit(
    host,
    queueItem({
      id: "submitted",
      text: "@Alex review this",
      mentions: [{ profileId: "first-recipient", start: 0, end: 5 }],
      sendRunId: "submitted-run",
      sendAttempts: 0,
      sendState: "waiting-idle",
    }),
  );
  const stored = listOutboxes(host)[0]!.queue[0]!;
  const owner = chatOutboxOwner(host);
  const submission = owner.beginSubmission(host, stored.id, options);
  expect(submission).toBeDefined();
  return { host, stored, owner, submission: submission! };
}

it("holds foreground rows only while the owner is current", () => {
  let current = true;
  const { host, stored, owner, submission } = admittedSubmission({
    inline: false,
    isCurrent: () => current,
  });
  const scope = listOutboxes(host)[0]!;
  expect(owner.hasPendingSubmission(scope, stored)).toBe(true);
  expect(readQueued(host, stored.id)).toEqual(stored);
  current = false;
  expect(owner.hasPendingSubmission(scope, stored)).toBe(false);
  expect(listOutboxes(host)[0]?.queue).toEqual([stored]);
  submission.release();
  expect(readQueued(host, stored.id)).toEqual(stored);
});

it.each(["delivery", "navigation"] as const)("keeps durable custody after %s", (change) => {
  const { host, stored, submission } = admittedSubmission();
  const sending = { sendState: "sending" as const, sendAttempts: 1 };
  expect(readQueued(host, stored.id)?.sendState).toBe("submitting");
  expect(listOutboxes(host)[0]?.queue).toEqual([stored]);
  if (change === "delivery") {
    expect(updateQueued(host, stored.id, (item) => ({ ...item, ...sending }))).toMatchObject(
      sending,
    );
  } else {
    host.sessionKey = "agent:default:other";
  }
  submission.release();
  if (change === "navigation") {
    expect(host.chatQueue).toEqual([]);
    expect(listOutboxes(host)[0]?.queue).toEqual([stored]);
    host.sessionKey = stored.sessionKey!;
    expect(readQueued(host, stored.id)).toEqual(stored);
  } else {
    expect(readQueued(host, stored.id)).toMatchObject(sending);
    expect(listOutboxes(host)[0]?.queue[0]).toMatchObject({
      sendState: "waiting-reconnect",
      sendAttempts: 1,
    });
  }
});

it.each(["recipient", "position"] as const)("shares %s replacements with peers", (change) => {
  const { host, stored, submission } = admittedSubmission();
  const peer = { ...host, chatQueue: [...host.chatQueue] };
  const replacement = {
    ...stored,
    ...(change === "recipient"
      ? { mentions: [{ profileId: "new-recipient", start: 0, end: 5 }] }
      : { orderKey: 2 }),
  };
  const changes = [{ expected: stored, next: replacement }];
  expect(updateQueueItems(host, host.sessionKey, changes, stored.agentId)).toBe(true);
  expect(readQueued(peer, stored.id)).toEqual(replacement);
  expect(removeQueued(peer, stored.id)).toBe("removed");
  submission.release();
  expect(readQueued(host, stored.id)).toBeNull();
});

it.each([
  ["main", "agent:default:workspace", "default"],
  ["agent:other:main", "agent:other:workspace", "other"],
  ["global", "global", "selected"],
  ["agent:bad agent:notes", "agent:bad agent:notes", "bad-agent"],
])("retains %s across reload and agent changes", (input, sessionKey, agentId) => {
  const host = { ...state, sessionKey: input };
  const queued = queueItem({ text: "follow up", sendState: "waiting-idle" });
  expect(persistComposer(host)).toBe(true);
  admit(host, queued);
  const reloaded = { ...state, assistantAgentId: "different" };
  expect(listOutboxes(reloaded)).toEqual([expectedOutbox(queued, sessionKey, agentId)]);
  expect(loadComposer(reloaded, sessionKey, agentId).snapshot?.draft).toBe("draft");
});

it("never restores a sole global agent draft into unresolved main", () => {
  expect(persistComposer({ ...state, sessionKey: "global" })).toBe(true);
  expect(
    loadComposer({ settings: { gatewayUrl }, connected: true, client: state.client }, "main")
      .snapshot,
  ).toBeNull();
});

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

it("preserves v1 global and qualified-main recovery separately", () => {
  const source = seed(1, {
    [globalScope]: legacy,
    [qualifiedScope]: { ...legacy, queue: [queue[0]] },
  });
  expect(listOutboxes(state)).toEqual([]);
  expect(loadComposer(state, "global", "selected").snapshot).toBeNull();
  const entries = readRecovery(state).entries;
  const scopes = entries.map((entry) => entry.sourceScopeKey).toSorted();
  expect(scopes).toEqual([qualifiedScope, globalScope]);
  expect(entries.find((entry) => entry.sourceScopeKey === globalScope)?.session).toEqual({
    ...legacy,
    queue: queue.map((item) => ({ ...item, sessionKey: "global", agentId: "selected" })),
  });
  expect(entries.find((entry) => entry.sourceScopeKey === qualifiedScope)?.session.queue).toEqual([
    { ...queue[0], sessionKey: "agent:selected:main", agentId: "selected" },
  ]);
  expect(sessionStorage.getItem(source.key)).toBeNull();
  expect(sessionStorage.getItem(storageTargetForComposer(state).key)).toBeNull();
  const migrated = JSON.parse(sessionStorage.getItem(storageTargetForGateway(gatewayUrl).key)!);
  expect(migrated.sessions[globalScope].draftRevision).toBe(42);
});

it("restores collapsed entries unsent into a confirmed empty target", () => {
  const source = seed(2, { [globalScope]: legacy });
  const [entry] = readRecovery(state).entries;
  expect(entry?.session).toEqual(legacy);
  expect(listOutboxes(state)).toEqual([]);
  const destination = destinationFor("agent:selected:review", "selected");
  expect(restoreRecovery(state, entry!, destination)).toBe("restored");
  expect(readRecovery(state).entries).toEqual([]);
  const restored = listOutboxes(state)[0]!;
  expect(
    restored.queue.map((item) => [item.id, item.sendRunId, item.sendAttempts, item.attachments]),
  ).toEqual(queue.map((item) => [item.id, item.sendRunId, item.sendAttempts, item.attachments]));
  expect(restored.queue[0]?.sendState).toBe("unconfirmed");
  expect(restored.queue.slice(1).every((item) => item.sendState === "failed")).toBe(true);
  expect(loadComposer(state, restored.sessionKey).snapshot?.goalMode).toEqual(legacy.goalMode);
  expect(sessionStorage.getItem(source.key)).toBeNull();
  expect(restoreRecovery(state, entry!, destination)).toBe("conflict");
});

it.each([2, 3] as const)("keeps v%s source bytes when migration exceeds quota", (version) => {
  const source = seed(version, { [mainScope]: legacy });
  const write = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
  expect(readRecovery(state).entries[0]?.session.queue).toHaveLength(60);
  expect(sessionStorage.getItem(source.key)).toBe(source.raw);
  expect(listOutboxes(state)).toEqual([]);
  write.mockRestore();
  expect(readRecovery(state).entries).toHaveLength(1);
  expect(sessionStorage.getItem(source.key)).toBeNull();
});

it.each(["newer text", "quote-only"] as const)("preserves %s recovery conflicts", (input) => {
  seed(2, { [globalScope]: legacy });
  const entry = readRecovery(state).entries[0]!;
  const before = destinationFor();
  const replyTarget = { messageId: "selected-message", text: "Keep this quote" };
  const next =
    input === "newer text"
      ? { ...state, chatMessage: "newer input" }
      : { ...state, chatMessage: "", chatReplyTarget: replyTarget };
  expect(persistComposer(next)).toBe(true);
  const destination = input === "newer text" ? before : destinationFor();
  expect(restoreRecovery(state, entry, destination)).toBe("conflict");
  const stored = loadComposer(state, state.sessionKey).snapshot;
  const field = input === "newer text" ? "draft" : "replyTarget";
  expect(stored?.[field]).toEqual(input === "newer text" ? "newer input" : replyTarget);
  expect(readRecovery(state).entries[0]).toEqual(entry);
});

it("recovers later legacy writes after migration", () => {
  const source = seed(1, { [mainScope]: legacy });
  const first = readRecovery(state).entries[0]!;
  const later = { ...legacy, draft: "written after downgrade", draftRevision: 99 };
  seed(1, { [mainScope]: later });
  const entries = readRecovery(state).entries;
  expect(entries.map((entry) => entry.session.draft)).toEqual([
    first.session.draft,
    "written after downgrade",
  ]);
  expect(listOutboxes(state)).toEqual([]);
  expect(sessionStorage.getItem(source.key)).toBeNull();
});

it("does not reimport after failed legacy deletion", () => {
  const source = seed(3, { [mainScope]: legacy });
  const remove = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {
    throw new Error("blocked legacy deletion");
  });
  const entry = readRecovery(state).entries[0]!;
  const destination = destinationFor();
  expect(restoreRecovery(state, entry, destination)).toBe("restored");
  expect(sessionStorage.getItem(source.key) || null).toBeNull();
  expect(readRecovery(state).entries).toEqual([]);
  expect(listOutboxes(state)[0]?.queue).toHaveLength(60);
  remove.mockRestore();
});

it("defers new recovery while full, then resumes after restoration", () => {
  const pending = Object.fromEntries(
    Array.from({ length: 80 }, (_, i) => [
      `old-${i}`,
      {
        sourceVersion: 2,
        sourceScopeKey: `old-${i}`,
        session: { draft: `draft ${i}`, draftRevision: i + 1, updatedAt: i + 1 },
      },
    ]),
  );
  seed(4, {}, storageTargetForGateway(gatewayUrl).key, pending);
  const source = seed(2, { [globalScope]: legacy });
  const recovery = readRecovery(state);
  expect(recovery.entries).toHaveLength(80);
  expect(sessionStorage.getItem(source.key)).toBe(source.raw);
  const destination = destinationFor();
  expect(restoreRecovery(state, recovery.entries[0]!, destination)).toBe("restored");
  const resumed = readRecovery(state);
  expect(resumed.blocked).toBe(false);
  expect(resumed.entries).toHaveLength(80);
  expect(resumed.entries.at(-1)?.session).toEqual(legacy);
  expect(loadComposer(state, state.sessionKey).snapshot?.draft).toBe("draft 0");
  expect(sessionStorage.getItem(source.key)).toBeNull();
  expect(recovery.blocked).toBe(true);
});

it("recovers targeted legacy rows separately from ambiguous drafts", () => {
  const exactItem = queueItem({
    id: "exact",
    text: "qualified",
    sessionKey: "agent:other:thread",
    agentId: "other",
    sendAttempts: 1,
    sendRunId: "original",
    sendState: "unconfirmed",
  });
  seed(2, {
    [globalScope]: {
      draft: "ambiguous draft",
      updatedAt: 1,
      queue: [
        exactItem,
        { id: "ambiguous", text: "collapsed", createdAt: 2, sessionKey: "global" },
      ],
    },
  });
  expect(listOutboxes(state)).toEqual([]);
  expect(loadComposer(state, "agent:other:thread").snapshot).toBeNull();
  const entries = readRecovery(state).entries;
  expect(entries).toHaveLength(2);
  const exact = entries.find((entry) => entry.session.queue?.[0]?.id === "exact")!;
  expect(exact.session.queue).toMatchObject([exactItem]);
  expect(entries.find((entry) => entry !== exact)?.session).toMatchObject({
    draft: "ambiguous draft",
    queue: [{ id: "ambiguous" }],
  });
  const destination = destinationFor("agent:other:thread", "other");
  expect(restoreRecovery(state, exact, destination!)).toBe("restored");
  expect(listOutboxes(state)[0]).toMatchObject(
    expectedOutbox(exactItem, "agent:other:thread", "other"),
  );
  expect(readRecovery(state).entries).toHaveLength(1);
});

it("keeps only row data when a durable row becomes a local model wait", () => {
  const host = { ...state, hello: null };
  const item = queueItem({ id: "model-wait" });
  admit(host, item);
  const stored = listOutboxes(host)[0]!.queue[0]!;

  updateQueued(host, item.id, (current) => ({ ...current, sendState: "waiting-model" }));

  expect(readQueued(host, item.id)).toEqual({ ...stored, sendState: "waiting-model" });
  expect(removeQueued(host, item.id)).toBe("removed");
  expect(host.chatQueue).toEqual([]);
  expect(readQueued(host, item.id)).toBeNull();
});
it("pins admission despite notification-driven default changes", () => {
  const host = { ...state, agentsList: { ...state.agentsList } };
  const unsubscribe = subscribeOutbox(() => {
    host.agentsList.mainKey = "changed";
  });
  try {
    const item = queueItem({ id: "captured-admission" });
    const admitted = admitQueueItem(host, captureAdmission(host, "main"), item) === "admitted";
    expect(listOutboxes(host)).toEqual([expectedOutbox(item)]);
    expect(admitted).toBe(true);
  } finally {
    unsubscribe();
  }
});
it("mutates captured scopes after mainKey changes", () => {
  const initial = {
    ...state,
    sessionKey: "agent:main:main",
    agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
  };
  admit(initial, queueItem({ id: "captured" }));
  const changed = { ...initial, agentsList: { ...initial.agentsList, mainKey: "workspace" } };
  const original = listOutboxes(changed)[0]!;
  const { sessionKey, agentId } = original;
  const item = original.queue[0]!;
  const next = {
    ...item,
    sendState: "unconfirmed" as const,
    sendAttempts: 1,
    sendRunId: "captured-attempt",
  };
  const changes = [{ expected: item, next }];
  expect(updateQueueItems(changed, sessionKey, changes, "other")).toBe(false);
  updateQueueItems(changed, sessionKey, [{ expected: item, next: null }], "other");
  expect(listOutboxes(changed)).toEqual([original]);
  expect(updateQueueItems(changed, sessionKey, changes, agentId)).toBe(true);
  expect(listOutboxes(changed)[0]).toMatchObject({
    sessionKey: initial.sessionKey,
    queue: [next],
  });
  expect(updateQueueItems(changed, sessionKey, [{ expected: next, next: null }], agentId)).toBe(
    true,
  );
  expect(listOutboxes(changed)).toEqual([]);
});
it.each(["bucket", "item"])("quarantines conflicting %s agents", (conflict) => {
  const scopeKey = `agent:main:notes\u0000agent:${conflict === "bucket" ? "work" : "main"}`;
  const identity = {
    id: "conflicting",
    agentId: "work",
    sessionKey: "agent:main:notes",
  };
  const items = [queueItem({ ...identity, text: "preserve me" })];
  sessionStorage.setItem(
    storageTargetForGateway(gatewayUrl).legacyKey,
    JSON.stringify({
      version: 1,
      sessions: { [scopeKey]: { updatedAt: 1, queue: items } },
    }),
  );
  expect(listOutboxes(state)).toEqual([]);
  expect(readRecovery(state).entries[0]?.session.queue?.[0]).toMatchObject(identity);
});
