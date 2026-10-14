/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import { outboxStorageScope } from "./outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  discardChatOutboxRecovery,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "./outbox-recovery.ts";
import type { StoredComposerState } from "./outbox-store-codec.ts";
import { createStoredChatOutboxReader, listStoredChatOutboxes } from "./outbox-store-projection.ts";
import { retireStoredComposerDrafts } from "./outbox-store-retirement.ts";
import {
  readProjectedOutboxStore,
  readStoredOutboxStore,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
  writeStoredOutboxStore,
} from "./outbox-store.ts";

function ownedState(gatewayUrl: string) {
  return {
    settings: { gatewayUrl },
    client: { recoveryScope: "summary-owner", recoveryScopeReady: true },
    connected: true,
  };
}

function ownedQueue(gatewayUrl: string, queue: ChatQueueItem[]): ChatQueueItem[] {
  return queue.map((item) => ({
    ...item,
    storageScope: outboxStorageScope(ownedState(gatewayUrl)),
  }));
}

function seedStore(
  target: ReturnType<typeof storageTargetForGateway>,
  sessions: StoredComposerState["sessions"],
  recovery: StoredComposerState["recovery"] = {},
) {
  sessionStorage.setItem(
    target.key,
    JSON.stringify({ version: 4, gatewayOwner: target.gatewayOwner, sessions, recovery }),
  );
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stored outbox summaries", () => {
  it.each(["raw", "cleared"])(
    "keeps newer legacy bytes published during %s source retirement",
    (input) => {
      const target = storageTargetForGateway("ws://reentrant-retirement.test");
      const scopeKey = storedChatOutboxScopeKey({
        sessionKey: "agent:main:dashboard:incognito-reentrant",
      });
      const source = (id: string) =>
        JSON.stringify({
          version: 3,
          gatewayOwner: target.gatewayOwner,
          sessions: {
            [scopeKey]: {
              draft: "Private legacy input",
              queue: [{ id, text: id, createdAt: 1 }],
              updatedAt: 1,
            },
          },
        });
      sessionStorage.setItem(target.blobKey, source("submitted"));
      if (input === "cleared") {
        const removal = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {});
        readStoredOutboxStore(sessionStorage, target);
        expect(sessionStorage.getItem(target.blobKey)).toBe("");
        removal.mockRestore();
      }
      const replacement = source("newer-submission");
      const remove = sessionStorage.removeItem.bind(sessionStorage);
      vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
        if (key === target.blobKey) {
          sessionStorage.setItem(key, replacement);
          throw new Error("Source changed during removal");
        }
        remove(key);
      });
      const migrated = readStoredOutboxStore(sessionStorage, target);
      expect(sessionStorage.getItem(target.blobKey)).toBe(replacement);
      expect(migrated.sessions[scopeKey]?.queue).toMatchObject([{ id: "submitted" }]);
    },
  );

  it.each([1, 3])(
    "retires acknowledged v%i private input after source deletion fails without reimporting queues",
    (version) => {
      const target = storageTargetForGateway("ws://acknowledged-private.test");
      const sourceKey =
        version === 1 ? target.legacyKey : version === 2 ? target.previousKey : target.blobKey;
      const scopeKey = storedChatOutboxScopeKey({
        sessionKey: "agent:main:dashboard:incognito-acknowledged",
      });
      const source = JSON.stringify({
        version,
        ...(version !== 1 ? { gatewayOwner: target.gatewayOwner } : {}),
        sessions: {
          [scopeKey]: {
            draft: "@Alex private legacy input",
            draftMentions: [{ profileId: "alex", start: 0, end: 5 }],
            goalMode: { action: "start", sessionId: "private-goal" },
            queue: [{ id: "submitted", text: "Submitted message", createdAt: 1 }],
            updatedAt: 1,
          },
          "main\u0000agent:main": { draft: "Ambiguous input", updatedAt: 1 },
        },
      });
      sessionStorage.setItem(sourceKey, source);
      const remove = sessionStorage.removeItem.bind(sessionStorage);
      let sourceRemovalBlocked = true;
      vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
        if (key === sourceKey && sourceRemovalBlocked) {
          throw new Error("Source deletion unavailable");
        }
        remove(key);
      });
      const write = sessionStorage.setItem.bind(sessionStorage);
      let sourceWritesBlocked = true;
      vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
        if (key === sourceKey && sourceWritesBlocked) {
          throw new Error("Source writes unavailable");
        }
        write(key, value);
      });
      const migrated = readStoredOutboxStore(sessionStorage, target);
      expect(sessionStorage.getItem(sourceKey)).toBe(source);
      expect(migrated.sessions[scopeKey]?.queue).toMatchObject([
        { id: "submitted", text: "Submitted message" },
      ]);
      expect(Object.values(migrated.recovery)[0]?.session.draft).toBe("Ambiguous input");
      sourceWritesBlocked = false;
      expect(readStoredOutboxStore(sessionStorage, target)).toEqual(migrated);
      const retained = sessionStorage.getItem(sourceKey) ?? "";
      expect(retained).not.toContain("private legacy input");
      expect(retained).not.toContain("profileId");
      expect(retained).not.toContain("private-goal");
      expect(readStoredOutboxStore(sessionStorage, target)).toEqual(migrated);
      sourceRemovalBlocked = false;
      expect(readStoredOutboxStore(sessionStorage, target)).toEqual(migrated);
      expect(sessionStorage.getItem(sourceKey)).toBeNull();
    },
  );

  it.each([1, 3])(
    "retires private input in a deferred v%i source without changing queued or ambiguous data",
    (version) => {
      const target = storageTargetForGateway("ws://deferred-private.test");
      const sourceKey =
        version === 1 ? target.legacyKey : version === 2 ? target.previousKey : target.blobKey;
      const scopeKey = storedChatOutboxScopeKey({
        sessionKey: "agent:main:dashboard:incognito-deferred",
      });
      const queued = { id: "submitted", text: "Submitted private message", createdAt: 1 };
      const privateRow = {
        draft: "@Alex private legacy input",
        draftMentions: [{ profileId: "alex", start: 0, end: 5 }],
        goalMode: { action: "start", sessionId: "private-session" },
        draftRevision: 7,
        queue: [queued],
        updatedAt: 1,
        unknownMetadata: "preserve",
      };
      const source = {
        version,
        ...(version !== 1 ? { gatewayOwner: target.gatewayOwner } : {}),
        sessions: {
          [scopeKey]: privateRow,
          "agent:main:dashboard:incognito-draft-only\u0000agent:main": {
            draft: "Private draft without an explicit revision",
            updatedAt: 2,
          },
          "agent:main:dashboard:incognito-goal-only\u0000agent:main": {
            goalMode: { action: "start", sessionId: "private-goal" },
            updatedAt: 3,
          },
          "main\u0000agent:main": { draft: "Ambiguous input", updatedAt: 1 },
        },
      };
      sessionStorage.setItem(sourceKey, JSON.stringify(source));
      const store = {
        version: 4,
        gatewayOwner: target.gatewayOwner,
        sessions: {},
        recovery: Object.fromEntries(
          Array.from({ length: 80 }, (_, index) => [
            `existing-${index}`,
            {
              sourceVersion: 4,
              sourceScopeKey: "main\u0000agent:main",
              session: { draft: `Existing ${index}`, updatedAt: 1 },
            },
          ]),
        ),
      };
      sessionStorage.setItem(target.key, JSON.stringify(store));
      expect(readStoredOutboxStore(sessionStorage, target).recoveryBlocked).toBe(true);
      expect(() => readStoredOutboxStore(sessionStorage, target)).not.toThrow();
      const retained = JSON.parse(sessionStorage.getItem(sourceKey)!);
      const { draft: _draft, draftMentions: _mentions, goalMode: _goal, ...preserved } = privateRow;
      expect(retained).toEqual({
        ...source,
        sessions: {
          [scopeKey]: preserved,
          "main\u0000agent:main": source.sessions["main\u0000agent:main"],
        },
      });
      expect(JSON.parse(sessionStorage.getItem(target.key)!)).toEqual(store);
      expect(readStoredOutboxStore(sessionStorage, target).recoveryBlocked).toBe(true);
      expect(JSON.parse(sessionStorage.getItem(sourceKey)!)).toEqual(retained);
      sessionStorage.setItem(target.key, JSON.stringify({ ...store, recovery: {} }));
      const remove = sessionStorage.removeItem.bind(sessionStorage);
      vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
        if (key !== sourceKey) {
          remove(key);
        }
      });
      const migrated = readStoredOutboxStore(sessionStorage, target);
      expect(
        Object.values(migrated.recovery).flatMap((entry) => entry.session.queue ?? []),
      ).toEqual([queued]);
      expect(Object.values(migrated.recovery)).toHaveLength(2);
      expect(sessionStorage.getItem(sourceKey)).not.toBeNull();
      expect(readStoredOutboxStore(sessionStorage, target)).toEqual(migrated);
    },
  );

  it("admits real legacy input when recovery is full of clear fences without replaying its source", () => {
    const target = storageTargetForGateway("ws://recovery-fence-capacity.test");
    const state = ownedState(target.gatewayOwner);
    const scopeKey = "global\u0000agent:main";
    const fence = { draftRevision: 100, updatedAt: 100 };
    sessionStorage.setItem(
      target.key,
      JSON.stringify({
        version: 4,
        gatewayOwner: target.gatewayOwner,
        sessions: { [scopeKey]: fence },
        recovery: Object.fromEntries(
          Array.from({ length: 80 }, (_, index) => [
            "empty-" + index,
            {
              sourceVersion: 3,
              sourceScopeKey: "old-" + index + "\u0000agent:main",
              session: { draftRevision: index + 1, updatedAt: index + 1 },
            },
          ]),
        ),
      }),
    );
    const source = JSON.stringify({
      version: 3,
      gatewayOwner: target.gatewayOwner,
      sessions: {
        [scopeKey]: { draft: "real saved input", draftRevision: 101, updatedAt: 101 },
        "main\u0000agent:main": { draftRevision: 99, updatedAt: 99 },
      },
    });
    sessionStorage.setItem(target.blobKey, source);
    const recovery = readChatOutboxRecovery(state);
    expect(recovery.blocked).toBe(false);
    expect(recovery.entries.map((entry) => entry.session.draft)).toEqual(["real saved input"]);
    expect(Object.keys(readStoredOutboxStore(sessionStorage, target).recovery)).toHaveLength(1);
    expect(readStoredOutboxStore(sessionStorage, target).sessions[scopeKey]).toEqual(fence);
    expect(discardChatOutboxRecovery(state, recovery.entries[0]!)).toBe("discarded");
    // A failed old-source deletion or downgraded writer cannot replay acknowledged bytes.
    sessionStorage.setItem(target.blobKey, source);
    expect(readChatOutboxRecovery(state)).toEqual({ entries: [], blocked: false });
    expect(readStoredOutboxStore(sessionStorage, target).sessions[scopeKey]).toEqual(fence);
  });

  it("retires private recovery input and rejects private destinations before roster metadata", () => {
    const target = storageTargetForGateway("ws://private-recovery.test");
    const sessionKey = "agent:main:dashboard:incognito-recovery";
    const scopeKey = storedChatOutboxScopeKey({ sessionKey });
    sessionStorage.setItem(
      target.key,
      JSON.stringify({
        version: 4,
        gatewayOwner: target.gatewayOwner,
        sessions: {},
        recovery: {
          legacy: {
            sourceVersion: 4,
            sourceScopeKey: scopeKey,
            session: {
              draft: "private recovery input",
              draftRevision: 4,
              updatedAt: 1,
              queue: [
                { id: "submitted", text: "Submitted message", createdAt: 1, sendState: "held" },
              ],
            },
          },
        },
      }),
    );
    const state = {
      settings: { gatewayUrl: target.gatewayOwner },
      agentsList: { defaultId: "main", mainKey: "main" },
    };
    const entries = readChatOutboxRecovery(state).entries;
    expect(entries[0]?.session).toEqual({
      draftRevision: 4,
      updatedAt: 1,
      queue: [{ id: "submitted", text: "Submitted message", createdAt: 1, sendState: "held" }],
    });
    expect(sessionStorage.getItem(target.key)).not.toContain("private recovery input");
    expect(captureChatOutboxRecoveryDestination(state, { sessionKey })).toBeNull();
  });

  it.each([
    { reason: "valid recipients", invalid: undefined },
    { reason: "out-of-range token", invalid: [{ profileId: "profile-alex", start: 0, end: 50 }] },
    {
      reason: "missing mention prefix",
      invalid: [{ profileId: "profile-alex", start: 1, end: 5 }],
    },
    { reason: "malformed annotations", invalid: "profile-alex" },
  ])("restores mention metadata or parks $reason for review", ({ invalid }) => {
    const target = storageTargetForGateway("ws://mention-outbox.test");
    const scopeKey = storedChatOutboxScopeKey({ sessionKey: "agent:main:mentions" });
    const mentions = [{ profileId: "profile-alex", start: 0, end: 5 }];
    if (invalid === undefined) {
      const store = readStoredOutboxStore(sessionStorage, target);
      store.sessions[scopeKey] = {
        draft: "@Alex draft",
        draftMentions: mentions,
        queue: [
          {
            id: "mention-send",
            text: "@Alex queued",
            mentions,
            createdAt: 1,
            sendRunId: "mention-run",
            sendState: "waiting-reconnect",
          },
        ],
        updatedAt: 1,
      };
      writeStoredOutboxStore(sessionStorage, target, store);
      mentions[0]!.profileId = "later-selection";
    } else {
      sessionStorage.setItem(
        target.key,
        JSON.stringify({
          version: 4,
          gatewayOwner: target.gatewayOwner,
          recovery: {},
          sessions: {
            [scopeKey]: {
              queue: [
                {
                  id: "corrupt-mention",
                  text: "@Alex review",
                  mentions: invalid,
                  createdAt: 1,
                  sendState: "waiting-reconnect",
                },
              ],
              updatedAt: 1,
            },
          },
        }),
      );
    }
    const restored = readStoredOutboxStore(sessionStorage, target).sessions[scopeKey];
    if (invalid === undefined) {
      expect(restored).toMatchObject({
        draft: "@Alex draft",
        draftMentions: [{ profileId: "profile-alex", start: 0, end: 5 }],
        queue: [
          {
            text: "@Alex queued",
            mentions: [{ profileId: "profile-alex", start: 0, end: 5 }],
            sendRunId: "mention-run",
            sendState: "waiting-reconnect",
          },
        ],
      });
    } else {
      expect(restored?.queue?.[0]).toMatchObject({ text: "@Alex review", sendState: "failed" });
      expect(restored?.queue?.[0]?.mentions).toBeUndefined();
      expect(restored?.queue?.[0]?.sendError).toBeTruthy();
    }
  });

  it.each([1, 2, 4])("refreshes a cached v%i projection after an external write", (version) => {
    const reader = createStoredChatOutboxReader();
    const changed = vi.fn();
    const unsubscribe = reader.subscribe(changed);
    const gatewayUrl = "ws://gateway.test/control";
    const state = { settings: { gatewayUrl }, client: null, connected: false };
    const target = storageTargetForGateway(gatewayUrl);
    const storageKey = `openclaw.control.chatComposer.v${version}:${encodeURIComponent(gatewayUrl)}`;
    const stored = (ids: string[]) =>
      JSON.stringify({
        version,
        ...(version !== 1 ? { gatewayOwner: gatewayUrl } : {}),
        ...(version === 4 ? { recovery: {} } : {}),
        sessions: {
          "agent:main:summary\u0000agent:main": {
            ...(ids.length > 1 ? { draft: "new" } : {}),
            queue: ids.map((id, createdAt) => ({ id, text: id, createdAt })),
            updatedAt: ids.length,
          },
        },
      });
    sessionStorage.setItem(storageKey, stored(["first"]));
    if (version !== 4) {
      const write = sessionStorage.setItem.bind(sessionStorage);
      vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
        if (key !== storageKey) {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        write(key, value);
      });
    }
    try {
      const first = readProjectedOutboxStore(sessionStorage, target);
      expect(readProjectedOutboxStore(sessionStorage, target)).toBe(first);
      expect(Object.values(first.sessions).flatMap((session) => session.queue ?? [])).toHaveLength(
        1,
      );
      expect(createStoredChatOutboxReader().read(ownedState(gatewayUrl)).total).toBe(0);
      const summary = reader.read(state);
      expect(reader.read({ ...state })).toBe(summary);
      expect(summary.hasSessionDraft("agent:main:summary")).toBe(false);

      sessionStorage.setItem(storageKey, stored(["first", "second"]));
      const event = new StorageEvent("storage", { key: storageKey });
      Object.defineProperty(event, "storageArea", { value: sessionStorage });
      window.dispatchEvent(event);
      const refreshed = readProjectedOutboxStore(sessionStorage, target);
      expect(refreshed).not.toBe(first);
      expect(
        Object.values(refreshed.sessions).flatMap((session) => session.queue ?? []),
      ).toHaveLength(2);
      expect(changed).toHaveBeenCalledOnce();
      expect(reader.read(state)).not.toBe(summary);
      expect(reader.read(state).hasSessionDraft("agent:main:summary")).toBe(true);
      expect(
        reader
          .read({ ...state, settings: { gatewayUrl: "ws://other.test" } })
          .hasSessionDraft("agent:main:summary"),
      ).toBe(false);
      expect(reader.read(state).hasSessionDraft("agent:main:summary")).toBe(true);
      const reconnected = reader.read(state);
      reader.invalidate();
      expect(reader.read(state)).not.toBe(reconnected);
    } finally {
      unsubscribe();
    }
  });

  it.each([1, 3])(
    "retains the last v%i source when quota blocks verified retirement",
    (version) => {
      const target = storageTargetForGateway("ws://gateway.test/control");
      const sourceKey =
        version === 1 ? target.legacyKey : version === 2 ? target.previousKey : target.blobKey;
      const scopeKey = storedChatOutboxScopeKey({ sessionKey: "thread", agentId: "main" });
      sessionStorage.setItem(
        sourceKey,
        JSON.stringify({
          version,
          ...(version !== 1 ? { gatewayOwner: target.gatewayOwner } : {}),
          sessions: {
            [scopeKey]: {
              queue: [{ id: "queued", text: "retire me", createdAt: 1 }],
              updatedAt: 1,
            },
          },
        }),
      );
      vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      });
      const store = readStoredOutboxStore(sessionStorage, target);
      expect(store.sessions[scopeKey]?.queue).toHaveLength(1);
      store.sessions = {};
      expect(() => writeStoredOutboxStore(sessionStorage, target, store)).toThrow("quota exceeded");
      expect(readStoredOutboxStore(sessionStorage, target).sessions[scopeKey]?.queue).toEqual([
        { id: "queued", text: "retire me", createdAt: 1, sessionKey: "thread" },
      ]);
      expect(sessionStorage.getItem(sourceKey)).toContain("retire me");
    },
  );

  it("clears every retained projection after an external storage clear", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeStoredChatOutboxChanges(listener);
    const gatewayUrls = ["ws://first.test/control", "ws://second.test/control"];
    for (const gatewayUrl of gatewayUrls) {
      sessionStorage.setItem(
        storageTargetForGateway(gatewayUrl, "summary-owner").key,
        JSON.stringify({
          version: 4,
          recovery: {},
          gatewayOwner: gatewayUrl,
          sessions: {
            "thread\u0000agent:main": {
              queue: ownedQueue(gatewayUrl, [{ id: gatewayUrl, text: gatewayUrl, createdAt: 1 }]),
              updatedAt: 1,
            },
          },
        }),
      );
      expect(createStoredChatOutboxReader().read(ownedState(gatewayUrl)).total).toBe(1);
    }

    sessionStorage.clear();
    const storageEvent = new StorageEvent("storage", { key: null });
    Object.defineProperty(storageEvent, "storageArea", { value: sessionStorage });
    window.dispatchEvent(storageEvent);
    unsubscribe();

    for (const gatewayUrl of gatewayUrls) {
      expect(createStoredChatOutboxReader().read(ownedState(gatewayUrl)).total).toBe(0);
    }
    expect(listener).toHaveBeenCalledOnce();
  });

  it.each(["captured", "quota", "batch"] as const)(
    "retires the captured scope while preserving other drafts (%s)",
    (scenario) => {
      const target = storageTargetForGateway("ws://captured-retirement.test");
      const captured = scenario === "captured";
      const failed = scenario === "quota";
      const oldKey = captured ? "agent:main:main" : failed ? "global" : "older";
      const agentId = failed ? "work" : "main";
      const scope = storedChatOutboxScopeKey({ sessionKey: oldKey, agentId });
      const other = storedChatOutboxScopeKey({
        sessionKey: captured ? "agent:main:current" : "newer",
      });
      const replacement = {
        draft: captured ? "new target" : "replacement",
        draftRevision: captured ? 11 : 1_000,
        updatedAt: captured ? 11 : 1_000,
      };
      seedStore(target, {
        [scope]: {
          draft: "retire me",
          draftRevision: 10,
          ...(captured ? {} : { queue: [{ id: "queued", text: "queued", createdAt: 1 }] }),
          updatedAt: 10,
        },
        ...(failed ? {} : { [other]: replacement }),
      });
      const before = sessionStorage.getItem(target.key);
      const write = vi.spyOn(sessionStorage, "setItem");
      if (failed) {
        write.mockImplementationOnce(() => {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        });
      }
      const listener = vi.fn();
      const unsubscribe = subscribeStoredChatOutboxChanges(listener);
      try {
        const cutoff = captured || failed ? 20 : 100;
        const result = retireStoredComposerDrafts(
          {
            settings: { gatewayUrl: target.gatewayOwner },
            ...(captured
              ? { agentsList: { defaultId: "main", mainKey: "current", scope: "per-sender" } }
              : {}),
          },
          [
            { key: oldKey, agentId, retireBeforeRevision: cutoff },
            ...(!captured && !failed
              ? [{ key: "newer", agentId: "main", retireBeforeRevision: cutoff }]
              : []),
          ],
        );
        expect(result.storageFailed).toBe(failed);
        expect(write).toHaveBeenCalledOnce();
        if (failed) {
          expect(result).toEqual({
            gatewayOwner: target.gatewayOwner,
            retirements: [
              {
                scope: { sessionKey: oldKey, agentId },
                minimumRevision: expect.any(Number),
                retireBeforeRevision: cutoff,
              },
            ],
            storageFailed: true,
          });
          expect(sessionStorage.getItem(target.key)).toBe(before);
        } else {
          const stored = readStoredOutboxStore(sessionStorage, target);
          expect(stored.sessions[scope]).toEqual({
            draftRevision: expect.any(Number),
            updatedAt: expect.any(Number),
          });
          expect(stored.sessions[scope]?.draftRevision).toBeGreaterThan(cutoff);
          expect(stored.sessions[other]).toEqual(replacement);
          expect(listener).toHaveBeenCalledOnce();
        }
      } finally {
        unsubscribe();
      }
    },
  );

  it.each([
    {
      name: "named sessions before defaults",
      state: { hello: null },
      storedKey: "thread-draft\u0000agent:main",
      present: ["thread-draft"],
      absent: ["agent:main:thread-draft"],
    },
    {
      name: "unresolved main before defaults",
      state: { hello: null },
      storedKey: "main\u0000agent:@unresolved",
      present: ["main"],
      absent: ["agent:main:main"],
    },
    {
      name: "configured default-main aliases",
      state: {
        assistantAgentId: "previous",
        agentsList: { defaultId: "work", mainKey: "workspace" },
      },
      storedKey: "agent:work:workspace\u0000agent:work",
      present: ["main", "workspace", "agent:work:main", "agent:work:workspace"],
      absent: ["agent:previous:main"],
    },
    {
      name: "qualified cross-agent main aliases",
      state: { agentsList: { defaultId: "main", mainKey: "workspace" } },
      storedKey: "agent:work:workspace\u0000agent:work",
      present: ["agent:work:main", "agent:work:workspace"],
      absent: ["main", "workspace", "agent:main:workspace"],
    },
    {
      name: "raw global and qualified selected-agent aliases",
      state: {
        assistantAgentId: "work",
        agentsList: { defaultId: "main", mainKey: "workspace", scope: "global" },
      },
      storedKey: "global\u0000agent:work",
      present: ["global", "agent:work:main", "agent:work:workspace"],
      absent: ["main", "workspace", "agent:main:main", "agent:work:global"],
    },
    {
      name: "global default-main aliases with another agent selected",
      state: {
        assistantAgentId: "work",
        agentsList: { defaultId: "main", mainKey: "workspace", scope: "global" },
      },
      storedKey: "global\u0000agent:main",
      present: ["main", "workspace", "agent:main:main"],
      absent: ["global", "agent:work:main"],
    },
    {
      name: "qualified global-named session",
      state: {
        assistantAgentId: "work",
        agentsList: { defaultId: "main", mainKey: "workspace", scope: "global" },
      },
      storedKey: "agent:work:global\u0000agent:work",
      present: ["agent:work:global"],
      absent: ["global", "main", "agent:work:main"],
    },
    {
      name: "opaque qualified session casing",
      state: { agentsList: { defaultId: "main", mainKey: "main" } },
      storedKey: "agent:work:matrix:channel:!Room:Server\u0000agent:work",
      present: ["agent:work:matrix:channel:!Room:Server", "Agent:Work:MATRIX:CHANNEL:!Room:Server"],
      absent: ["agent:work:matrix:channel:!room:server"],
    },
  ])("queries draft and attention snapshots for $name", ({ state, storedKey, present, absent }) => {
    const gatewayUrl = "ws://gateway.test/control";
    seedStore(storageTargetForGateway(gatewayUrl, "summary-owner"), {
      [storedKey]: {
        draft: "finish this message",
        draftRevision: 3,
        queue: ownedQueue(gatewayUrl, [
          { id: "failed", text: "retry this message", createdAt: 3, sendState: "failed" },
        ]),
        updatedAt: 3,
      },
      "thread-empty\u0000agent:main": { draftRevision: 2, updatedAt: 2 },
      "thread-queue\u0000agent:main": {
        queue: ownedQueue(gatewayUrl, [{ id: "queued", text: "queued", createdAt: 1 }]),
        updatedAt: 1,
      },
    });
    const summary = createStoredChatOutboxReader().read({ ...state, ...ownedState(gatewayUrl) });
    const read = vi.spyOn(sessionStorage, "getItem");
    sessionStorage.clear();

    expect(summary.total).toBe(2);
    for (const sessionKey of present) {
      expect(summary.hasSessionDraft(sessionKey), sessionKey).toBe(true);
      expect(summary.attentionCountForSession(sessionKey), sessionKey).toBe(1);
    }
    for (const sessionKey of [...absent, "thread-empty", "thread-queue", "absent"]) {
      expect(summary.hasSessionDraft(sessionKey), sessionKey).toBe(false);
      expect(summary.attentionCountForSession(sessionKey), sessionKey).toBe(0);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("bridges matching storage events until the last subscriber leaves", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const unsubscribeFirst = subscribeStoredChatOutboxChanges(firstListener);
    const unsubscribeSecond = subscribeStoredChatOutboxChanges(secondListener);

    expect(addEventListener).toHaveBeenCalledWith("storage", expect.any(Function));

    window.dispatchEvent(
      new StorageEvent("storage", { key: "openclaw.control.chatComposer.v4:gateway" }),
    );
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new StorageEvent("storage", { key: "openclaw.control.settings.v1" }));
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new StorageEvent("storage", { key: "openclaw.control.chatComposer.v1:gateway" }),
    );
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    expect(removeEventListener).not.toHaveBeenCalledWith("storage", expect.any(Function));

    unsubscribeSecond();
    expect(removeEventListener).toHaveBeenCalledWith("storage", expect.any(Function));
  });

  it("rejects a store owned by another gateway", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 4,
        recovery: {},
        gatewayOwner: "ws://other.test/control",
        sessions: {
          "global\u0000agent:work": {
            queue: [{ id: "queued", text: "queued", createdAt: 1 }],
            updatedAt: 1,
          },
        },
      }),
    );

    expect(
      createStoredChatOutboxReader().read({
        client: null,
        connected: false,
        settings: { gatewayUrl },
        agentsList: { defaultId: "work", mainKey: "workspace" },
      }).total,
    ).toBe(0);
    expect(JSON.parse(sessionStorage.getItem(storageKey) ?? "{}").gatewayOwner).toBe(
      "ws://other.test/control",
    );
  });

  it("projects metadata-only badges and counts distinct operator-review rows", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const restoredSendStates = [
      undefined,
      "waiting-idle",
      "executing-command",
      "sending",
      "waiting-reconnect",
    ] as const;
    seedStore(storageTargetForGateway(gatewayUrl, "summary-owner"), {
      "agent:main:a\u0000agent:main": { draft: "private draft", updatedAt: 1 },
      "agent:work:b\u0000agent:work": {
        queue: ownedQueue(gatewayUrl, [
          ...restoredSendStates.map((sendState, index) => ({
            id: `healthy-${index}`,
            text: `healthy ${index}`,
            createdAt: index,
            sendState,
          })),
          { id: "held", text: "private queue", createdAt: 9, sendState: "held" },
          { id: "failed", text: "failed", createdAt: 10, sendState: "failed" },
          { id: "failed", text: "duplicate", createdAt: 11, sendState: "failed" },
          {
            id: "unconfirmed",
            text: "unconfirmed",
            createdAt: 12,
            sendState: "unconfirmed",
          },
          {
            id: "unconfirmed",
            text: "duplicate uncertainty",
            createdAt: 13,
            sendState: "unconfirmed",
          },
          {
            id: "other-owner",
            text: "another credential's attachment",
            createdAt: 14,
            sendState: "failed",
            attachmentPayload: { key: "bundle", recoveryScope: "other-owner", tabId: "tab" },
          },
        ]),
        updatedAt: 13,
      },
      "thread-b\u0000agent:main": {
        queue: ownedQueue(gatewayUrl, [
          {
            id: "unconfirmed",
            text: "other scope",
            createdAt: 14,
            sendState: "unconfirmed",
          },
        ]),
        updatedAt: 14,
      },
    });

    const summary = createStoredChatOutboxReader().read(ownedState(gatewayUrl));
    expect(summary.total).toBe(9);
    expect(summary.sessions).toEqual([
      {
        agentId: "main",
        sessionKey: "agent:main:a",
        hasComposerDraft: true,
        outboxAttentionCount: 0,
      },
      {
        agentId: "work",
        sessionKey: "agent:work:b",
        hasComposerDraft: false,
        outboxAttentionCount: 4,
      },
      {
        agentId: undefined,
        sessionKey: "thread-b",
        hasComposerDraft: false,
        outboxAttentionCount: 1,
      },
    ]);
    expect(summary.attentionCountForSession("agent:work:b")).toBe(4);
    expect(summary.attentionCountForSession("thread-b")).toBe(1);
    expect(summary.attentionCountForSession("absent")).toBe(0);
  });

  it("derives badges and replay from the same migrated durable queue", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyKey = `openclaw.control.chatComposer.v1:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      legacyKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "main\u0000agent:previous": {
            queue: [
              { id: "removed", text: "removed", createdAt: 1 },
              { id: "shared", text: "older", createdAt: 2 },
            ],
            removedQueueItemIds: ["removed"],
            updatedAt: 2,
          },
          "global\u0000agent:work": {
            queue: [{ id: "shared", text: "newer", createdAt: 3 }],
            updatedAt: 3,
          },
        },
      }),
    );
    const state = {
      ...ownedState(gatewayUrl),
      assistantAgentId: "work",
      agentsList: { defaultId: "work", mainKey: "main" },
    };

    // Legacy migration retains unowned bytes; explicit review admits the selected row.
    expect(createStoredChatOutboxReader().read(state).total).toBe(0);
    const recovery = readChatOutboxRecovery(state);
    expect(
      recovery.entries.find((entry) => entry.sourceScopeKey === "main\u0000agent:previous")?.session
        .queue,
    ).toMatchObject([{ id: "shared", text: "older" }]);
    const entry = recovery.entries.find(
      (candidate) => candidate.sourceScopeKey === "global\u0000agent:work",
    )!;
    const destination = captureChatOutboxRecoveryDestination(state, {
      sessionKey: "global",
      agentId: "work",
    })!;
    expect(restoreChatOutboxRecovery(state, entry, destination)).toBe("restored");
    const summary = createStoredChatOutboxReader().read(state);
    const outboxes = listStoredChatOutboxes(state);

    expect(summary.total).toBe(1);
    expect(outboxes[0]?.queue).toEqual([
      {
        id: "shared",
        text: "newer",
        createdAt: 3,
        sessionKey: "global",
        agentId: "work",
        storageScope: outboxStorageScope(state),
        sendState: "failed",
        sendError:
          "Recovered message. Review this destination and retry only if it did not arrive.",
      },
    ]);
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
  });
});
