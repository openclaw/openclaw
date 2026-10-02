/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatSelectionAnnotation,
} from "../../lib/chat/chat-types.ts";
import * as payloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import {
  readStoredOutboxStore,
  storageTargetForGateway,
  storageTargetForComposer,
  storedChatOutboxScopeKey,
  writeStoredOutboxStore,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload } from "./outbox-payloads.ts";

const gatewayUrl = "ws://synthetic-blob-recovery.test";
const dataUrl = "data:text/plain;base64,Y29tcGxldGUgc291cmNlIGJ5dGVz";
const target = storageTargetForGateway(gatewayUrl);
function hostFor(recoveryScope = "principal-a") {
  const host = makeChatHost({
    requestHandlers: {},
    settings: { gatewayUrl },
    sessionKey: "agent:main:review",
    agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
  });
  vi.spyOn(
    expectDefined(host.client, "authenticated client"),
    "recoveryScope",
    "get",
  ).mockReturnValue(recoveryScope);
  return host;
}
async function prepare(
  host: ReturnType<typeof hostFor>,
  id: string,
  sessionKey = "global",
  selectionAnnotation?: ChatSelectionAnnotation,
  attachmentOrigin?: "paste" | "file",
) {
  const item: ChatQueueItem = {
    id,
    text: id,
    createdAt: 10,
    orderKey: 5,
    sessionKey,
    agentId: "main",
    sendRunId: `original-${id}`,
    sendAttempts: 1,
    sendState: "unconfirmed",
    attachments: [
      {
        id: `${id}-file`,
        mimeType: "text/plain",
        fileName: "source.txt",
        sizeBytes: 21,
        ...(attachmentOrigin ? { origin: attachmentOrigin } : {}),
        dataUrl,
        ...(selectionAnnotation ? { selectionAnnotation } : {}),
      },
    ],
  };
  const result = await prepareOutboxPayload(host, item);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") {
    throw new Error("Expected complete stored payload");
  }
  const { attachmentStorageError: _, ...stored } = { ...item, ...result.update };
  return {
    ...stored,
    attachments: item.attachments?.map(
      ({ id: attachmentId, mimeType, fileName, sizeBytes, origin }) => {
        const metadata: ChatAttachment = { id: attachmentId, mimeType, fileName, sizeBytes };
        if (origin) {
          metadata.origin = origin;
        }
        return metadata;
      },
    ),
  };
}
function seed(items: ChatQueueItem[], sessionKey = "global", version = 3) {
  const key = `openclaw.control.chatComposer.v${version}:${encodeURIComponent(gatewayUrl)}`;
  const raw = JSON.stringify({
    version,
    ...(version === 4 ? { recovery: {} } : {}),
    gatewayOwner: gatewayUrl,
    sessions: {
      [storedChatOutboxScopeKey({ sessionKey, agentId: "main" })]: {
        updatedAt: 10,
        draftRevision: 42,
        queue: items,
      },
    },
  });
  sessionStorage.setItem(key, raw);
  return { key, raw };
}
async function expectBytes(host: ReturnType<typeof hostFor>, item: ChatQueueItem) {
  const result = await prepareOutboxPayload(host, item, "handoff");
  expect(result.status).toBe("ready");
  const attachments = result.status === "ready" ? result.update.attachments : [];
  expect(attachments).toHaveLength(1);
  const restoredUrl = expectDefined(
    getChatAttachmentDataUrl(expectDefined(attachments?.[0], "restored attachment")),
    "restored attachment data URL",
  );
  const comma = restoredUrl.indexOf(",");
  expect(comma).toBeGreaterThan(0);
  const metadata = restoredUrl.slice(0, comma).split(";");
  expect(metadata[0]).toBe("data:text/plain");
  expect(metadata.at(-1)).toBe("base64");
  expect(Buffer.from(restoredUrl.slice(comma + 1), "base64")).toEqual(
    Buffer.from("complete source bytes"),
  );
  return attachments?.[0];
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  installOutboxBrowserStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Blob-preserving metadata migration", () => {
  it("stores attachment payloads without secure-context-only browser APIs", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends Exclude<BufferSource, ArrayBuffer>>(array: T): T => {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
        return array;
      },
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });

    const host = hostFor();
    const item = await prepare(host, "insecure-http");

    await expectBytes(host, item);
    expect(sessionStorage.getItem("openclaw.control.outboxTab.v1")).toBe(
      "07070707-0707-4707-8707-070707070707",
    );
  });

  it("recovers a selected-text annotation with its queued file payload", async () => {
    const annotation: ChatSelectionAnnotation = {
      text: "complete source bytes",
      comment: "Keep this context. 🦞",
      sessionKey: "agent:main:review",
      messageId: "assistant-1",
      entryId: "entry-1",
      start: 5,
      end: 26,
    };
    const host = hostFor();
    const item = await prepare(host, "selection", "global", annotation);
    const restored = await expectBytes(host, item);
    expect(restored?.selectionAnnotation).toEqual(annotation);
  });

  it("does not settle payload preparation under a pending connected recovery owner", async () => {
    const host = hostFor();
    const original = await prepare(host, "pending-owner");
    const started = createDeferred();
    const release = createDeferred();
    const read = payloadStore.readOutboxPayload;
    vi.spyOn(payloadStore, "readOutboxPayload").mockImplementationOnce(async (...args) => {
      const value = await read(...args);
      started.resolve();
      await release.promise;
      return value;
    });
    const prepared = prepareOutboxPayload(host, original, "handoff");
    await started.promise;
    const ready = vi
      .spyOn(expectDefined(host.client, "connected client"), "recoveryScopeReady", "get")
      .mockReturnValue(false);
    release.resolve();
    expect(await prepared).toEqual({ status: "failed", reason: "unavailable" });
    ready.mockRestore();
    await expectBytes(host, original);
  });

  it("hydrates queued attachment bytes after offline reload before a new hello", async () => {
    const host = hostFor();
    const original = await prepare(host, "offline-blob");
    const reloaded = {
      ...host,
      connected: false,
      client: new GatewayBrowserClient({ url: gatewayUrl, offlineRecoveryScope: "principal-a" }),
    };
    await expectBytes(reloaded, original);
    reloaded.client.retireOfflineRecoveryScope();
    expect(await prepareOutboxPayload(reloaded, original, "handoff")).toEqual({
      status: "failed",
      reason: "unavailable",
    });
  });

  it.each(["agent:main:topic", "global"])(
    "migrates landed v3 %s without retiring its exact Blob or attempt",
    async (sessionKey) => {
      const host = hostFor();
      const item = await prepare(host, "legacy", sessionKey);
      const source = seed([item], sessionKey);
      const cleanup = vi.spyOn(payloadStore, "removeOutboxPayloads");
      const migrated = readStoredOutboxStore(sessionStorage, target);
      expect(sessionStorage.getItem(source.key)).toBeNull();
      expect(migrated.version).toBe(4);
      const rows = [
        ...Object.values(migrated.sessions),
        ...Object.values(migrated.recovery).map((entry) => entry.session),
      ];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ draftRevision: 42, queue: [item] });
      {
        expect(listStoredChatOutboxes(host)).toEqual([]);
        const entry = expectDefined(readChatOutboxRecovery(host).entries[0], "owned recovery");
        const destination = expectDefined(
          captureChatOutboxRecoveryDestination(host, {
            sessionKey: host.sessionKey,
            agentId: "main",
          }),
          "empty target",
        );
        expect(restoreChatOutboxRecovery(host, entry, destination)).toBe("restored");
      }
      const restored = expectDefined(listStoredChatOutboxes(host)[0]?.queue[0], "restored input");
      expect(restored).toMatchObject({
        id: item.id,
        sendRunId: item.sendRunId,
        sendAttempts: 1,
        sendState: "unconfirmed",
        orderKey: 5,
        attachmentPayload: item.attachmentPayload,
      });
      await expectBytes(host, restored);
      expect(cleanup).not.toHaveBeenCalled();
      const ownedTarget = storageTargetForComposer(host);
      const reopened = readStoredOutboxStore(sessionStorage, ownedTarget);
      reopened.sessions = {};
      writeStoredOutboxStore(sessionStorage, ownedTarget, reopened);
      expect(cleanup).toHaveBeenCalledWith([item.attachmentPayload]);
      await Promise.all(
        cleanup.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
      );
      expect(await prepareOutboxPayload(host, restored, "handoff")).toEqual({
        status: "failed",
        reason: "missing",
      });
    },
  );

  it.each(["noop", "quota"])(
    "keeps source Blob bytes across %s migration and explicit transfer failures",
    async (failure) => {
      const host = hostFor();
      const item = await prepare(host, "retained");
      const source = seed([item]);
      const cleanup = vi.spyOn(payloadStore, "removeOutboxPayloads");
      const fail = () => {
        if (failure === "quota") {
          throw new DOMException("quota", "QuotaExceededError");
        }
      };
      let write = vi.spyOn(sessionStorage, "setItem").mockImplementation(fail);
      expect(readChatOutboxRecovery(host).entries[0]?.session.queue).toEqual([item]);
      expect(sessionStorage.getItem(source.key)).toBe(source.raw);
      await expectBytes(host, item);
      write.mockRestore();
      const entry = expectDefined(readChatOutboxRecovery(host).entries[0], "migrated source");
      const before = sessionStorage.getItem(target.key);
      const destination = expectDefined(
        captureChatOutboxRecoveryDestination(host, {
          sessionKey: host.sessionKey,
          agentId: "main",
        }),
        "empty destination",
      );
      write = vi.spyOn(sessionStorage, "setItem").mockImplementation(fail);
      expect(restoreChatOutboxRecovery(host, entry, destination)).toBe("storage-failed");
      expect(sessionStorage.getItem(target.key)).toBe(before);
      await expectBytes(host, item);
      expect(cleanup).not.toHaveBeenCalled();
      write.mockRestore();
      expect(restoreChatOutboxRecovery(host, entry, destination)).toBe("restored");
      await expectBytes(host, item);
      expect(cleanup).not.toHaveBeenCalled();
    },
  );

  it.each(["noop-write", "failed-write", "noop-remove", "failed-remove"])(
    "keeps recovery inert and retains shared bytes across %s of the unscoped source",
    async (failure) => {
      const host = hostFor();
      const foreign = hostFor("principal-b");
      const item = await prepare(host, "partial-transfer");
      const unrelated = await prepare(host, "destination-only", host.sessionKey);
      seed([item], "global", 4);
      if (failure.endsWith("write")) {
        // A retained row makes source retirement write instead of remove the bucket.
        const store = readStoredOutboxStore(sessionStorage, target);
        store.sessions[storedChatOutboxScopeKey({ sessionKey: "agent:main:other" })] = {
          draft: "unrelated legacy draft",
          updatedAt: 10,
        };
        writeStoredOutboxStore(sessionStorage, target, store);
      }
      const entry = expectDefined(
        readChatOutboxRecovery(host).entries.find(
          (candidate) => candidate.session.queue?.[0]?.id === item.id,
        ),
        "unscoped source",
      );
      const scope = { sessionKey: host.sessionKey, agentId: "main" };
      const capture = () =>
        expectDefined(captureChatOutboxRecoveryDestination(host, scope), "destination");
      const set = sessionStorage.setItem.bind(sessionStorage);
      const remove = sessionStorage.removeItem.bind(sessionStorage);
      const fail = () => {
        if (failure.startsWith("failed")) {
          throw new Error("source retirement blocked");
        }
      };
      const write = vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
        const pending = JSON.parse(value) as { recovery: Record<string, unknown> };
        if (
          key === target.key &&
          failure.endsWith("write") &&
          !Object.keys(pending.recovery).length
        ) {
          fail();
          return;
        }
        set(key, value);
      });
      const removal = vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
        if (key === target.key && failure.endsWith("remove")) {
          fail();
          return;
        }
        remove(key);
      });
      const cleanup = vi.spyOn(payloadStore, "removeOutboxPayloads");
      const ownedTarget = storageTargetForComposer(host);
      const destinationKey = storedChatOutboxScopeKey(scope);
      const clearDestination = () => {
        const store = readStoredOutboxStore(sessionStorage, ownedTarget);
        store.sessions = {};
        writeStoredOutboxStore(sessionStorage, ownedTarget, store);
      };
      const settleCleanup = async () => {
        await Promise.all(
          cleanup.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          ),
        );
      };

      expect(restoreChatOutboxRecovery(host, entry, capture())).toBe("storage-failed");
      expect(
        readChatOutboxRecovery(host).entries.find((row) => row.session.queue?.[0]?.id === item.id)
          ?.session,
      ).toEqual(entry.session);
      const committed = readStoredOutboxStore(sessionStorage, ownedTarget);
      expect(committed.sessions[destinationKey]).toBeUndefined();
      expect(Object.values(committed.recovery).flatMap((row) => row.session.queue ?? [])).toEqual(
        entry.session.queue,
      );
      // Unrelated retirement must not collect bytes owned by either inert staging copy.
      committed.sessions[destinationKey] = { updatedAt: 10, queue: [unrelated] };
      writeStoredOutboxStore(sessionStorage, ownedTarget, committed);
      clearDestination();
      await settleCleanup();
      await expectBytes(host, item);
      expect(cleanup).toHaveBeenCalledExactlyOnceWith([unrelated.attachmentPayload]);
      expect(await prepareOutboxPayload(host, unrelated, "handoff")).toEqual({
        status: "failed",
        reason: "missing",
      });
      expect(
        readChatOutboxRecovery(foreign).entries.every(
          (candidate) => !candidate.session.queue?.length,
        ),
      ).toBe(true);
      expect(listStoredChatOutboxes(foreign)).toEqual([]);
      const foreignDestination = expectDefined(
        captureChatOutboxRecoveryDestination(foreign, scope),
        "foreign destination",
      );
      expect(restoreChatOutboxRecovery(foreign, entry, foreignDestination)).toBe("conflict");

      // Another failed recovery/deletion must preserve the same source bytes too.
      expect(restoreChatOutboxRecovery(host, entry, capture())).toBe("storage-failed");
      clearDestination();
      await settleCleanup();
      await expectBytes(host, item);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(
        readChatOutboxRecovery(host).entries.find((row) => row.session.queue?.[0]?.id === item.id)
          ?.session,
      ).toEqual(entry.session);
      expect(
        readStoredOutboxStore(sessionStorage, ownedTarget).sessions[destinationKey],
      ).toBeUndefined();
      write.mockRestore();
      removal.mockRestore();

      // Once source retirement succeeds, the destination is the last owner.
      expect(restoreChatOutboxRecovery(host, entry, capture())).toBe("restored");
      expect(
        readChatOutboxRecovery(host).entries.every((candidate) => !candidate.session.queue?.length),
      ).toBe(true);
      await expectBytes(host, item);
      clearDestination();
      await settleCleanup();
      expect(cleanup).toHaveBeenLastCalledWith([item.attachmentPayload]);
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(await prepareOutboxPayload(host, item, "handoff")).toEqual({
        status: "failed",
        reason: "missing",
      });
    },
  );

  it("partitions a mixed-principal v3 bucket while retaining foreign recovery across unrelated retirement", async () => {
    const a = hostFor();
    const b = hostFor("principal-b");
    const first = await prepare(a, "principal-a-input");
    const second = await prepare(b, "principal-b-input");
    const plain: ChatQueueItem = { id: "plain", text: "unbound legacy text", createdAt: 11 };
    seed([first, second, plain]);
    const cleanup = vi.spyOn(payloadStore, "removeOutboxPayloads");
    const entriesA = readChatOutboxRecovery(a).entries;
    const entriesB = readChatOutboxRecovery(b).entries;
    expect(entriesA.flatMap((entry) => entry.session.queue?.map((item) => item.id) ?? [])).toEqual([
      first.id,
      plain.id,
    ]);
    expect(entriesB.flatMap((entry) => entry.session.queue?.map((item) => item.id) ?? [])).toEqual([
      second.id,
      plain.id,
    ]);
    const ownedA = expectDefined(
      entriesA.find((entry) => entry.session.queue?.[0]?.id === first.id),
      "A entry",
    );
    const destination = expectDefined(
      captureChatOutboxRecoveryDestination(a, { sessionKey: a.sessionKey, agentId: "main" }),
      "A destination",
    );
    expect(restoreChatOutboxRecovery(b, ownedA, destination)).toBe("conflict");
    expect(restoreChatOutboxRecovery(a, ownedA, destination)).toBe("restored");
    const ownedTarget = storageTargetForComposer(a);
    const raw = readStoredOutboxStore(sessionStorage, ownedTarget);
    raw.sessions = {};
    writeStoredOutboxStore(sessionStorage, ownedTarget, raw);
    expect(cleanup).toHaveBeenCalledWith([first.attachmentPayload]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expectBytes(b, second);
    expect(readChatOutboxRecovery(b).entries).toEqual(entriesB);
    const client = expectDefined(b.client, "B client");
    const ready = vi.spyOn(client, "recoveryScopeReady", "get").mockReturnValue(false);
    expect(() => readChatOutboxRecovery(b)).toThrow("Offline account recovery is unavailable");
    expect(
      captureChatOutboxRecoveryDestination(b, { sessionKey: b.sessionKey, agentId: "main" }),
    ).toBeNull();
    b.connected = false;
    expect(readChatOutboxRecovery(b).entries).toEqual(entriesB);
    ready.mockRestore();
  });

  it.each(["noop-remove", "failed-remove", "deferred-legacy", "unreadable-legacy"])(
    "retains bytes when %s cannot establish complete retirement",
    async (failure) => {
      const host = hostFor();
      const item = await prepare(host, "retire", "agent:main:topic");
      seed([item], "agent:main:topic");
      const store = readStoredOutboxStore(sessionStorage, target);
      // Exercise removal rather than receipt-bearing writes as well as deferred sources.
      delete store.legacyReceipts;
      writeStoredOutboxStore(sessionStorage, target, store);
      const cleanup = vi.spyOn(payloadStore, "removeOutboxPayloads");
      if (failure === "noop-remove" || failure === "failed-remove") {
        vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {
          if (failure === "failed-remove") {
            throw new Error("blocked removal");
          }
        });
      } else {
        seed([item]);
        if (failure === "unreadable-legacy") {
          const get = sessionStorage.getItem.bind(sessionStorage);
          vi.spyOn(sessionStorage, "getItem").mockImplementation((key) => {
            if (key === target.blobKey) {
              throw new Error("blocked source read");
            }
            return get(key);
          });
        }
      }
      store.sessions = {};
      if (failure === "noop-remove" || failure === "failed-remove") {
        expect(() => writeStoredOutboxStore(sessionStorage, target, store)).toThrow();
      } else {
        writeStoredOutboxStore(sessionStorage, target, store);
      }
      expect(cleanup).not.toHaveBeenCalled();
      await expectBytes(host, item);
    },
  );
  it.each(["paste", "file", undefined] as const)(
    "preserves %s origin and bytes after durable queue reload",
    async (origin) => {
      const host = hostFor();
      const item = await prepare(host, `origin-${origin}`, "agent:main:review", undefined, origin);
      seed([item], "agent:main:review", 4);
      const store = readStoredOutboxStore(sessionStorage, target);
      const restoredItem = Object.values(store.sessions)[0]?.queue?.[0];
      const restored = await expectBytes(host, expectDefined(restoredItem, "stored queue item"));
      expect(restored?.origin).toBe(origin);
    },
  );
});
