/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  captureChatOutboxRecoveryDestination,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "./outbox-recovery.ts";
import type { StoredComposerSession, StoredComposerState } from "./outbox-store-codec.ts";
import {
  readStoredOutboxStore,
  storageTargetForComposer,
  storageTargetForGateway,
  storedChatOutboxScopeKey,
  writeStoredOutboxStore,
} from "./outbox-store.ts";

const gatewayUrl = "wss://transfer.test";
const sourceScope = "agent:main:legacy\u0000agent:main";
const firstScope = { sessionKey: "agent:main:first", agentId: "main" };
const secondScope = { sessionKey: "agent:main:second", agentId: "main" };
function fixture(kind: "queue" | "draft", sibling = false) {
  const state = {
    settings: { gatewayUrl },
    connected: true,
    client: { recoveryScope: "account-a", recoveryScopeReady: true },
    agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
    sessionKey: firstScope.sessionKey,
    chatMessage: "",
    chatQueue: [],
  };
  const session: StoredComposerSession = {
    updatedAt: 1,
    draftRevision: 1,
    ...(kind === "draft"
      ? { draft: "Retained draft 雪" }
      : {
          queue: [
            {
              id: "original-input",
              text: "Retained queue 雪",
              createdAt: 1,
              sendRunId: "original-attempt",
              sendAttempts: 1,
              sendState: "unconfirmed" as const,
            },
          ],
        }),
  };
  const source = storageTargetForGateway(gatewayUrl);
  sessionStorage.setItem(
    source.key,
    JSON.stringify({
      version: 4,
      gatewayOwner: gatewayUrl,
      recovery: {},
      sessions: {
        [sourceScope]: session,
        ...(sibling
          ? { "agent:main:sibling\u0000agent:main": { draft: "untouched", updatedAt: 2 } }
          : {}),
      },
    }),
  );
  const entry = () =>
    readChatOutboxRecovery(state).entries.find((row) => row.sourceScopeKey === sourceScope)!;
  const destination = (scope = firstScope) => captureChatOutboxRecoveryDestination(state, scope)!;
  const stored = () => readStoredOutboxStore(sessionStorage, storageTargetForComposer(state));
  return { state, session, source, entry, destination, stored };
}
beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["queue", "draft"] as const)(
  "never duplicates %s recovery across destinations after failed source retirement",
  (kind) => {
    const f = fixture(kind);
    const original = f.entry();
    const remove = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {
      throw new Error("blocked retirement");
    });
    expect(restoreChatOutboxRecovery(f.state, original, f.destination())).toBe("storage-failed");
    remove.mockRestore();
    // Reopen all durable metadata: no in-memory deduplication can own this retry.
    const reopened = createStorageMock();
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      reopened.setItem(key, sessionStorage.getItem(key)!);
    }
    vi.stubGlobal("sessionStorage", reopened);
    expect(f.entry().session).toEqual(f.session);
    expect(restoreChatOutboxRecovery(f.state, f.entry(), f.destination(secondScope))).toBe(
      "restored",
    );
    const sessions = f.stored().sessions;
    expect(sessions[storedChatOutboxScopeKey(firstScope)]).toBeUndefined();
    expect(Object.keys(sessions)).toEqual([storedChatOutboxScopeKey(secondScope)]);
    expect(sessions[storedChatOutboxScopeKey(secondScope)]).toMatchObject(
      kind === "draft"
        ? { draft: "Retained draft 雪" }
        : {
            queue: [
              {
                id: "original-input",
                text: "Retained queue 雪",
                sendRunId: "original-attempt",
                sendAttempts: 1,
                sendState: "unconfirmed",
                storageScope: JSON.stringify([gatewayUrl, "account-a"]),
              },
            ],
          },
    );
    expect(readChatOutboxRecovery(f.state).entries).toEqual([]);
  },
);

const stages = ["claim", "stage", "retire-write", "retire-remove", "publish"] as const;
const failures = ["throw", "silent", "after-write"] as const;
it.each(
  stages.flatMap((stage) =>
    failures.flatMap((failure) =>
      (["queue", "draft"] as const).map((kind) => ({ stage, failure, kind })),
    ),
  ),
)(
  "retains one $kind through $failure at $stage and a different-destination retry",
  ({ stage, failure, kind }) => {
    const f = fixture(kind, stage === "retire-write");
    const original = f.entry();
    const ownedKey = storageTargetForComposer(f.state).key;
    const set = sessionStorage.setItem.bind(sessionStorage);
    const remove = sessionStorage.removeItem.bind(sessionStorage);
    let failuresSeen = 0;
    const fail = (commit: () => void) => {
      failuresSeen++;
      if (failure === "after-write") {
        commit();
      }
      if (failure !== "silent") {
        throw new Error("Injected " + stage);
      }
    };
    const write = vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
      const record = JSON.parse(value) as {
        sessions: Record<string, StoredComposerSession>;
        recovery: Record<string, { sourceScopeKey: string }>;
      };
      const staging = Object.values(record.recovery).some(
        (row) => row.sourceScopeKey === sourceScope,
      );
      const matches =
        key === f.source.key
          ? (stage === "claim" && staging) || (stage === "retire-write" && !staging)
          : key === ownedKey &&
            ((stage === "stage" && staging) || (stage === "publish" && !staging));
      if (matches) {
        return fail(() => set(key, value));
      }
      set(key, value);
    });
    const removal = vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
      if (key === f.source.key && stage === "retire-remove") {
        return fail(() => remove(key));
      }
      remove(key);
    });
    expect(restoreChatOutboxRecovery(f.state, original, f.destination())).toBe("storage-failed");
    expect(failuresSeen).toBe(1);
    write.mockRestore();
    removal.mockRestore();
    const reopened = createStorageMock();
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      reopened.setItem(key, sessionStorage.getItem(key)!);
    }
    vi.stubGlobal("sessionStorage", reopened);
    const committed = stage === "publish" && failure === "after-write";
    if (committed) {
      expect(f.entry()).toBeUndefined();
      expect(restoreChatOutboxRecovery(f.state, original, f.destination(secondScope))).toBe(
        "conflict",
      );
    } else {
      expect(Object.keys(f.stored().sessions)).toEqual([]);
      expect(f.entry().session).toEqual(f.session);
      expect(
        readChatOutboxRecovery(f.state).entries.filter((row) => row.sourceScopeKey === sourceScope),
      ).toHaveLength(1);
      expect(restoreChatOutboxRecovery(f.state, f.entry(), f.destination(secondScope))).toBe(
        "restored",
      );
    }
    const sessions = f.stored().sessions;
    const scope = committed ? firstScope : secondScope;
    expect(Object.keys(sessions)).toEqual([storedChatOutboxScopeKey(scope)]);
    expect(sessions[storedChatOutboxScopeKey(scope)]).toMatchObject(
      kind === "draft"
        ? { draft: f.session.draft }
        : {
            queue: [
              {
                ...f.session.queue![0],
                sessionKey: scope.sessionKey,
                agentId: scope.agentId,
                storageScope: JSON.stringify([gatewayUrl, "account-a"]),
              },
            ],
          },
    );
    expect(
      readChatOutboxRecovery(f.state).entries.filter((row) => row.sourceScopeKey === sourceScope),
    ).toEqual([]);
    if (stage === "retire-write") {
      expect(readChatOutboxRecovery(f.state).entries[0]?.session.draft).toBe("untouched");
    }
  },
);

it.each(["account", "client", "input", "stored-input"] as const)(
  "retains recovery instead of publishing across reentrant %s replacement",
  (change) => {
    const f = fixture("draft");
    const original = f.entry();
    const set = sessionStorage.setItem.bind(sessionStorage);
    let changed = false;
    const write = vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
      set(key, value);
      if (key !== f.source.key || changed) {
        return;
      }
      changed = true;
      if (change === "account") {
        f.state.client.recoveryScope = "account-b";
      } else if (change === "client") {
        f.state.client = { ...f.state.client };
      } else if (change === "input") {
        f.state.chatMessage = "newer live input";
      } else {
        set(
          storageTargetForComposer(f.state).key,
          JSON.stringify({
            version: 4,
            gatewayOwner: gatewayUrl,
            recovery: {},
            sessions: {
              [storedChatOutboxScopeKey(firstScope)]: {
                draft: "newer stored input",
                draftRevision: 999,
                updatedAt: 9,
              },
            },
          }),
        );
      }
    });
    expect(restoreChatOutboxRecovery(f.state, original, f.destination())).toBe("conflict");
    write.mockRestore();
    expect(changed).toBe(true);
    if (change === "account") {
      expect(readChatOutboxRecovery(f.state).entries).toEqual([]);
      f.state.client.recoveryScope = "account-a";
    }
    expect(f.entry().session).toEqual(f.session);
    expect(f.stored().sessions[storedChatOutboxScopeKey(firstScope)]?.draft).toBe(
      change === "stored-input" ? "newer stored input" : undefined,
    );
    if (change === "input") {
      expect(f.state.chatMessage).toBe("newer live input");
    }
    f.state.chatMessage = "";
    expect(restoreChatOutboxRecovery(f.state, f.entry(), f.destination(secondScope))).toBe(
      "restored",
    );
    expect(f.stored().sessions[storedChatOutboxScopeKey(secondScope)]?.draft).toBe(f.session.draft);
  },
);

it("rejects a reentrant second restore while the durable claim is being written", () => {
  const f = fixture("queue");
  const original = f.entry();
  const first = f.destination();
  const second = f.destination(secondScope);
  const set = sessionStorage.setItem.bind(sessionStorage);
  let nested: string | undefined;
  vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
    set(key, value);
    if (key === f.source.key && nested === undefined) {
      nested = restoreChatOutboxRecovery(f.state, original, second);
    }
  });
  expect(restoreChatOutboxRecovery(f.state, original, first)).toBe("restored");
  expect(nested).toBe("conflict");
  expect(Object.keys(f.stored().sessions)).toEqual([storedChatOutboxScopeKey(firstScope)]);
});

it.each(["queue", "draft"] as const)(
  "retains staged %s when the destination outbox is full",
  (kind) => {
    const f = fixture(kind);
    const target = storageTargetForComposer(f.state);
    const store = f.stored();
    for (let index = 0; index < 20; index++) {
      store.sessions["agent:main:occupied-" + index + "\u0000agent:main"] = {
        updatedAt: Date.now() + 1000 + index,
        queue: [
          {
            id: "occupied-" + index,
            text: "keep",
            createdAt: index,
            storageScope: JSON.stringify([gatewayUrl, "account-a"]),
          },
        ],
      };
    }
    writeStoredOutboxStore(sessionStorage, target, store);
    expect(restoreChatOutboxRecovery(f.state, f.entry(), f.destination())).toBe("storage-failed");
    expect(f.entry().session).toEqual(f.session);
    expect(Object.keys(f.stored().sessions)).toHaveLength(20);
    const freed = f.stored();
    delete freed.sessions["agent:main:occupied-0\u0000agent:main"];
    writeStoredOutboxStore(sessionStorage, target, freed);
    expect(restoreChatOutboxRecovery(f.state, f.entry(), f.destination(secondScope))).toBe(
      "restored",
    );
    expect(Object.keys(f.stored().sessions)).toHaveLength(20);
    expect(f.stored().sessions[storedChatOutboxScopeKey(secondScope)]).toMatchObject(
      kind === "draft" ? { draft: f.session.draft } : { queue: [{ id: "original-input" }] },
    );
  },
);

it("preserves newer legacy input written reentrantly during the claim", () => {
  const f = fixture("draft");
  const original = f.entry();
  const set = sessionStorage.setItem.bind(sessionStorage);
  let replaced = false;
  const write = vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
    set(key, value);
    if (key !== f.source.key || replaced) {
      return;
    }
    replaced = true;
    const store = JSON.parse(value);
    store.sessions[sourceScope] = { draft: "new legacy input", updatedAt: 2, draftRevision: 2 };
    set(key, JSON.stringify(store));
  });
  expect(restoreChatOutboxRecovery(f.state, original, f.destination())).toBe("storage-failed");
  write.mockRestore();
  expect(restoreChatOutboxRecovery(f.state, original, f.destination(secondScope))).toBe("conflict");
  const entries = readChatOutboxRecovery(f.state).entries;
  expect(
    entries
      .map((entry) => entry.session.draft)
      .toSorted((left, right) => (left === right ? 0 : (left ?? "") < (right ?? "") ? -1 : 1)),
  ).toEqual(["Retained draft 雪", "new legacy input"]);
  const claimed = entries.find((entry) => entry.session.draft === f.session.draft)!;
  expect(restoreChatOutboxRecovery(f.state, claimed, f.destination(secondScope))).toBe("restored");
  expect(f.stored().sessions[storedChatOutboxScopeKey(secondScope)]?.draft).toBe(f.session.draft);
  expect(readChatOutboxRecovery(f.state).entries.map((entry) => entry.session.draft)).toEqual([
    "new legacy input",
  ]);
});

it.each(["stage", "retire"] as const)(
  "revalidates account and live input after %s before publication",
  (boundary) => {
    for (const change of ["account", "input"] as const) {
      vi.stubGlobal("sessionStorage", createStorageMock());
      const f = fixture("draft");
      const ownedKey = storageTargetForComposer(f.state).key;
      const set = sessionStorage.setItem.bind(sessionStorage);
      const remove = sessionStorage.removeItem.bind(sessionStorage);
      let changed = false;
      const replace = () => {
        changed = true;
        if (change === "account") {
          f.state.client.recoveryScope = "account-b";
        } else {
          f.state.chatMessage = "newer input";
        }
      };
      const write = vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
        set(key, value);
        if (!changed && boundary === "stage" && key === ownedKey) {
          replace();
        }
      });
      const removal = vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
        remove(key);
        if (!changed && boundary === "retire" && key === f.source.key) {
          replace();
        }
      });
      expect(restoreChatOutboxRecovery(f.state, f.entry(), f.destination())).toBe("conflict");
      write.mockRestore();
      removal.mockRestore();
      expect(changed).toBe(true);
      if (change === "account") {
        expect(readChatOutboxRecovery(f.state).entries).toEqual([]);
        f.state.client.recoveryScope = "account-a";
      } else {
        expect(f.state.chatMessage).toBe("newer input");
      }
      expect(f.entry().session).toEqual(f.session);
      expect(f.stored().sessions).toEqual({});
      f.state.chatMessage = "";
      expect(restoreChatOutboxRecovery(f.state, f.entry(), f.destination(secondScope))).toBe(
        "restored",
      );
      expect(Object.keys(f.stored().sessions)).toEqual([storedChatOutboxScopeKey(secondScope)]);
    }
  },
);

it("retains a recovered draft that pending-defaults retention would omit", () => {
  const f = fixture("draft");
  const target = storageTargetForComposer(f.state);
  const owned = f.stored();
  for (let index = 0; index < 20; index++) {
    owned.sessions["opaque-" + index + "\u0000agent:main"] = {
      draft: "pending " + index,
      awaitingDefaults: true,
      updatedAt: index + 1,
    };
  }
  writeStoredOutboxStore(sessionStorage, target, owned);
  const pending = f.stored().sessions;
  expect(restoreChatOutboxRecovery(f.state, f.entry(), f.destination())).toBe("storage-failed");
  expect(f.stored().sessions).toEqual(pending);
  const reopened = createStorageMock();
  for (let index = 0; index < sessionStorage.length; index++) {
    const key = sessionStorage.key(index)!;
    reopened.setItem(key, sessionStorage.getItem(key)!);
  }
  vi.stubGlobal("sessionStorage", reopened);
  expect(f.entry()?.session).toEqual(f.session);
  const freed = f.stored();
  delete freed.sessions["opaque-0\u0000agent:main"];
  writeStoredOutboxStore(sessionStorage, target, freed);
  expect(restoreChatOutboxRecovery(f.state, f.entry(), f.destination(secondScope))).toBe(
    "restored",
  );
  expect(f.stored().sessions[storedChatOutboxScopeKey(secondScope)]?.draft).toBe(f.session.draft);
  expect(f.stored().sessions[storedChatOutboxScopeKey(firstScope)]).toBeUndefined();
  expect(Object.keys(f.stored().sessions)).toHaveLength(20);
  expect(readChatOutboxRecovery(f.state).entries).toEqual([]);
});

it.each(
  (["stage", "retire", "publication"] as const).flatMap((boundary) =>
    (["queue", "draft"] as const).flatMap((kind) =>
      (["session", "recovery"] as const).map((sourceKind) => ({ boundary, kind, sourceKind })),
    ),
  ),
)(
  "never republishes identical $kind from $sourceKind resurrected at $boundary",
  ({ boundary, kind, sourceKind }) => {
    const f = fixture(kind);
    if (sourceKind === "recovery") {
      const legacy = readStoredOutboxStore(sessionStorage, f.source);
      delete legacy.sessions[sourceScope];
      legacy.recovery.original = {
        sourceVersion: 4,
        sourceScopeKey: sourceScope,
        session: f.session,
      };
      writeStoredOutboxStore(sessionStorage, f.source, legacy);
    }
    const original = f.entry();
    const target = storageTargetForComposer(f.state);
    const set = sessionStorage.setItem.bind(sessionStorage);
    const remove = sessionStorage.removeItem.bind(sessionStorage);
    const get = sessionStorage.getItem.bind(sessionStorage);
    let retired = false;
    let reinstated = false;
    const reinstate = () => {
      reinstated = true;
      const raw = get(f.source.key);
      const legacy: StoredComposerState = raw
        ? JSON.parse(raw)
        : { version: 4, gatewayOwner: gatewayUrl, sessions: {}, recovery: {} };
      if (sourceKind === "session") {
        legacy.sessions[sourceScope] = f.session;
      } else {
        legacy.recovery.original = {
          sourceVersion: 4,
          sourceScopeKey: sourceScope,
          session: f.session,
        };
      }
      writeStoredOutboxStore(sessionStorage, f.source, legacy);
    };
    const write = vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
      set(key, value);
      if (!reinstated && boundary === "stage" && key === target.key) {
        reinstate();
      }
    });
    const removal = vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
      remove(key);
      if (key === f.source.key) {
        retired = true;
        if (!reinstated && boundary === "retire") {
          reinstate();
        }
      }
    });
    const read = vi.spyOn(sessionStorage, "getItem").mockImplementation((key) => {
      if (!reinstated && retired && boundary === "publication" && key === target.key) {
        reinstate();
      }
      return get(key);
    });
    expect(restoreChatOutboxRecovery(f.state, original, f.destination())).toBe(
      boundary === "retire" ? "storage-failed" : "conflict",
    );
    write.mockRestore();
    removal.mockRestore();
    read.mockRestore();
    expect(reinstated).toBe(true);
    expect(f.stored().sessions).toEqual({});
    const reopened = createStorageMock();
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index)!;
      reopened.setItem(key, sessionStorage.getItem(key)!);
    }
    vi.stubGlobal("sessionStorage", reopened);
    expect(readChatOutboxRecovery(f.state).entries).toHaveLength(1);
    const foreign = { ...f.state, client: { ...f.state.client, recoveryScope: "account-b" } };
    expect(readChatOutboxRecovery(foreign).entries).toEqual([]);
    expect(
      restoreChatOutboxRecovery(
        foreign,
        original,
        captureChatOutboxRecoveryDestination(foreign, secondScope)!,
      ),
    ).toBe("conflict");
    const resumed = readChatOutboxRecovery(f.state).entries[0]!;
    expect(resumed.session).toEqual(f.session);
    expect(restoreChatOutboxRecovery(f.state, resumed, f.destination(secondScope))).toBe(
      "restored",
    );
    expect(Object.keys(f.stored().sessions)).toEqual([storedChatOutboxScopeKey(secondScope)]);
    expect(f.stored().sessions[storedChatOutboxScopeKey(secondScope)]).toMatchObject(
      kind === "draft"
        ? { draft: f.session.draft }
        : {
            queue: [
              {
                ...f.session.queue![0],
                sessionKey: secondScope.sessionKey,
                storageScope: JSON.stringify([gatewayUrl, "account-a"]),
              },
            ],
          },
    );
    expect(restoreChatOutboxRecovery(f.state, original, f.destination())).toBe("conflict");
    expect(readChatOutboxRecovery(f.state).entries).toEqual([]);
  },
);

it("rejects an omitted required destination before changing storage without overriding retention", () => {
  const f = fixture("draft");
  const target = storageTargetForComposer(f.state);
  const owned = f.stored();
  owned.recovery.retained = { sourceVersion: 4, sourceScopeKey: sourceScope, session: f.session };
  for (let index = 0; index < 20; index++) {
    owned.sessions["opaque-" + index + "\u0000agent:main"] = {
      draft: "pending " + index,
      awaitingDefaults: true,
      updatedAt: index + 1,
    };
  }
  writeStoredOutboxStore(sessionStorage, target, owned);
  const previous = sessionStorage.getItem(target.key);
  const next = f.stored();
  const key = storedChatOutboxScopeKey(firstScope);
  next.sessions[key] = { ...f.session, updatedAt: Date.now() };
  delete next.recovery.retained;
  const set = vi.spyOn(sessionStorage, "setItem");
  const remove = vi.spyOn(sessionStorage, "removeItem");
  expect(() =>
    writeStoredOutboxStore(sessionStorage, target, next, { requiredSessionKey: key }),
  ).toThrow("Required chat outbox destination exceeds retention");
  expect(set).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(target.key)).toBe(previous);
  next.recovery = owned.recovery;
  writeStoredOutboxStore(sessionStorage, target, next);
  expect(f.stored().sessions[key]).toBeUndefined();
  expect(Object.keys(f.stored().sessions)).toHaveLength(20);
  expect(f.stored().recovery.retained?.session).toEqual(f.session);
});

it("preserves existing drafts when a recovered queue would evict them", () => {
  const f = fixture("queue");
  const target = storageTargetForComposer(f.state);
  const store = f.stored();
  for (let index = 0; index < 20; index++) {
    store.sessions["agent:main:draft-" + index + "\u0000agent:main"] = {
      draft: "existing input " + index,
      updatedAt: index + 1,
    };
  }
  writeStoredOutboxStore(sessionStorage, target, store);
  const before = f.stored().sessions;
  expect(restoreChatOutboxRecovery(f.state, f.entry(), f.destination())).toBe("storage-failed");
  expect(f.stored().sessions).toEqual(before);
  expect(f.entry().session).toEqual(f.session);
  const released = f.stored();
  delete released.sessions["agent:main:draft-0\u0000agent:main"];
  writeStoredOutboxStore(sessionStorage, target, released);
  expect(restoreChatOutboxRecovery(f.state, f.entry(), f.destination(secondScope))).toBe(
    "restored",
  );
  const after = f.stored().sessions;
  for (let index = 1; index < 20; index++) {
    const key = "agent:main:draft-" + index + "\u0000agent:main";
    expect(after[key]).toEqual(before[key]);
  }
  expect(after[storedChatOutboxScopeKey(secondScope)]?.queue?.[0]?.id).toBe("original-input");
  expect(readChatOutboxRecovery(f.state).entries).toEqual([]);
});
