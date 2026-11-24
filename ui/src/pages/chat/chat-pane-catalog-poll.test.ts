/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionsCatalogReadResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { catalogMessageId } from "./catalog-message-id.ts";
import { catalogList } from "./chat-pane-catalog.test-support.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
  resetTranscriptTestDom();
});

it("polls a visible read-only Gateway transcript without losing older history or overlapping reads", async () => {
  const key = { catalogId: "openclaw", hostId: "gateway:team", threadId: "remote-session" };
  const fixture = createMountedPanes([]);
  const client = fixture.state.client!;
  const originalRequest = client.request.bind(client);
  const page = (ids: number[]): SessionsCatalogReadResult => ({
    ...key,
    items: ids.map((id) => ({ id: String(id), type: "agentMessage", text: `answer ${id}` })),
    nextCursor: "initial-older",
  });
  let latest: Promise<SessionsCatalogReadResult> = Promise.resolve(page([3, 2]));
  const older = createDeferred<SessionsCatalogReadResult>();
  let reads = 0;
  vi.spyOn(client, "request").mockImplementation(async (method, ...args) => {
    if (method === "sessions.catalog.list") {
      return catalogList(key, [
        {
          threadId: key.threadId,
          status: "live",
          archived: false,
          canContinue: false,
          canArchive: false,
        },
      ]);
    }
    if (method === "sessions.catalog.read") {
      reads++;
      return (args[0] as { cursor?: string }).cursor ? older.promise : latest;
    }
    return originalRequest(method, ...args);
  });
  const pane = fixture.mount(buildCatalogSessionKey(key, "main"));
  await vi.waitFor(() => expect(pane.history.catalogMessages).toHaveLength(2));
  const pendingOlder = pane.loadCatalogSession(key, true);
  await vi.waitFor(() => expect(reads).toBe(2));
  latest = Promise.resolve(page([4, 3]));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reads).toBe(2);
  expect(await pane.pollCatalogSession()).toBe(false);
  older.resolve({ ...page([2, 1]), nextCursor: "retained-older" });
  await expect(pendingOlder).resolves.toBe(true);
  expect(pane.history.catalogMessages.map(catalogMessageId)).toEqual(["1", "2", "3"]);
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.waitFor(() => expect(reads).toBe(3));
  await vi.waitFor(() =>
    expect(pane.history.catalogMessages.map(catalogMessageId)).toEqual(["1", "2", "3", "4"]),
  );
  expect(pane.history.catalogCursor).toBe("retained-older");

  const pending = createDeferred<SessionsCatalogReadResult>();
  latest = pending.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.waitFor(() => expect(reads).toBe(4));
  expect(await pane.pollCatalogSession()).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reads).toBe(4);
  pane.presented = false;
  pending.resolve(page([5, 4]));
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reads).toBe(4);
  expect(pane.history.catalogMessages.map(catalogMessageId)).toEqual(["1", "2", "3", "4"]);
  latest = Promise.resolve(page([6, 5, 4]));
  pane.presented = true;
  await vi.waitFor(() =>
    expect(pane.history.catalogMessages.map(catalogMessageId)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]),
  );
  expect(pane.history.catalogCursor).toBe("retained-older");
});

it.each(["missing row", "missing host", "disconnected source", "source error"])(
  "recovers after %s without reading an unavailable selection",
  async (unavailable) => {
    const key = { catalogId: "openclaw", hostId: "gateway:team", threadId: "remote-session" };
    const fixture = createMountedPanes([]);
    const client = fixture.state.client!;
    const originalRequest = client.request.bind(client);
    const session = {
      threadId: key.threadId,
      status: "live" as const,
      archived: false,
      canContinue: false,
      canArchive: false,
    };
    let available = true;
    let reads = 0;
    let lists = 0;
    vi.spyOn(client, "request").mockImplementation(async (method, ...args) => {
      if (method === "sessions.catalog.list") {
        lists++;
        const result = catalogList(
          key,
          !available && unavailable === "missing row" ? [] : [session],
        );
        const host = result.catalogs[0]!.hosts[0]!;
        if (!available) {
          if (unavailable === "missing host") {
            result.catalogs[0]!.hosts = [];
          }
          if (unavailable === "disconnected source") {
            host.connected = false;
          }
          if (unavailable === "source error") {
            host.error = { code: "SOURCE_UNAVAILABLE", message: "unavailable" };
          }
        }
        return result;
      }
      if (method === "sessions.catalog.read") {
        reads++;
        return {
          ...key,
          items: [{ id: String(reads), type: "agentMessage", text: "retained" }],
          nextCursor: "older",
        };
      }
      return originalRequest(method, ...args);
    });
    const pane = fixture.mount(buildCatalogSessionKey(key, "main"));
    await vi.waitFor(() => expect(reads).toBe(1));
    await vi.waitFor(() => expect(pane.history.catalogMessages).toHaveLength(1));
    available = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lists).toBeGreaterThan(1);
    expect(reads).toBe(1);
    expect(pane.history.catalogSession).toBeNull();
    expect(pane.state.lastError).toBeTruthy();
    expect(pane.history.catalogMessages.map(catalogMessageId)).toEqual(["1"]);
    expect(await pane.loadCatalogSession(key, true)).toBe(false);
    expect(reads).toBe(1);
    const unavailableLists = lists;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lists).toBeGreaterThan(unavailableLists);
    expect(reads).toBe(1);
    available = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(reads).toBe(2));
    await vi.waitFor(() => expect(pane.state.lastError).toBeNull());
    expect(pane.history.catalogSession?.threadId).toBe(key.threadId);
  },
);

it("discards a pre-reconnect poll and recovers with a fresh lookup", async () => {
  const key = { catalogId: "openclaw", hostId: "gateway:team", threadId: "remote-session" };
  const fixture = createMountedPanes([]);
  const client = fixture.state.client!;
  const originalRequest = client.request.bind(client);
  const page = (id: string): SessionsCatalogReadResult => ({
    ...key,
    items: [{ id, type: "agentMessage", text: id }],
  });
  const pending = createDeferred<SessionsCatalogReadResult>();
  let result = Promise.resolve(page("initial"));
  let reads = 0;
  vi.spyOn(client, "request").mockImplementation(async (method, ...args) => {
    if (method === "sessions.catalog.list") {
      return catalogList(key, [
        {
          threadId: key.threadId,
          status: "live",
          archived: false,
          canContinue: false,
          canArchive: false,
        },
      ]);
    }
    if (method === "sessions.catalog.read") {
      reads++;
      return result;
    }
    return originalRequest(method, ...args);
  });
  const pane = fixture.mount(buildCatalogSessionKey(key, "main"));
  await vi.waitFor(() => expect(pane.history.catalogMessages).toHaveLength(1));
  result = pending.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(reads).toBe(2);
  pane.state.connected = false;
  fixture.context.gateway.snapshot.phase = "reconnecting";
  pane.connectionGeneration++;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(reads).toBe(2);
  pane.state.connected = true;
  fixture.context.gateway.snapshot.phase = "connected";
  pending.resolve(page("stale"));
  await vi.dynamicImportSettled();
  expect(pane.history.catalogMessages.map(catalogMessageId)).toEqual(["initial"]);
  result = Promise.resolve(page("fresh"));
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.waitFor(() =>
    expect(pane.history.catalogMessages.map(catalogMessageId)).toEqual(["fresh"]),
  );
});

it.each(["missing row", "missing host", "disconnected source"])(
  "recovers initial %s from only the outbound Session Share route",
  async (unavailable) => {
    const key = { catalogId: "openclaw", hostId: "gateway:team", threadId: "remote-session" };
    const fixture = createMountedPanes([]);
    const client = fixture.state.client!;
    const original = client.request.bind(client);
    let available = false;
    let reads = 0;
    let lists = 0;
    vi.spyOn(client, "request").mockImplementation(async (method, ...args) => {
      if (method === "sessions.catalog.list") {
        lists++;
        const result = catalogList(
          key,
          !available && unavailable === "missing row"
            ? []
            : [
                {
                  threadId: key.threadId,
                  status: "live",
                  archived: false,
                  canContinue: false,
                  canArchive: false,
                },
              ],
        );
        if (!available && unavailable === "missing host") {
          result.catalogs[0]!.hosts = [];
        }
        if (!available && unavailable === "disconnected source") {
          result.catalogs[0]!.hosts[0]!.connected = false;
        }
        return result;
      }
      if (method === "sessions.catalog.read") {
        reads++;
        return { ...key, items: [] };
      }
      return original(method, ...args);
    });
    const pane = fixture.mount(buildCatalogSessionKey(key, "main"));
    await vi.waitFor(() => expect(pane.state.lastError).toBeTruthy());
    expect(reads).toBe(0);
    const initial = lists;
    available = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(reads).toBe(1));
    expect(lists).toBeGreaterThan(initial);
  },
);

it("does not turn a generic Gateway catalog into a Session Share poller", async () => {
  const key = { catalogId: "codex", hostId: "gateway:local", threadId: "thread" };
  const fixture = createMountedPanes([]);
  const client = fixture.state.client!;
  const original = client.request.bind(client);
  let lists = 0;
  vi.spyOn(client, "request").mockImplementation(async (method, ...args) => {
    if (method === "sessions.catalog.list") {
      lists++;
      return catalogList(key, []);
    }
    if (method === "sessions.catalog.read") {
      return { ...key, items: [] };
    }
    return original(method, ...args);
  });
  const pane = fixture.mount(buildCatalogSessionKey(key, "main"));
  await vi.waitFor(() => expect(lists).toBe(1));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await pane.pollCatalogSession()).toBe(false);
  expect(lists).toBe(1);
});

it.each([
  ["rewound tail", [3, 2]],
  ["changed tail", [6, 5, 2]],
])("replaces an overlapping %s and adopts its fresh older cursor", async (_name, latestIds) => {
  const key = { catalogId: "openclaw", hostId: "gateway:team", threadId: "remote-session" };
  const fixture = createMountedPanes([]);
  const client = fixture.state.client!;
  const original = client.request.bind(client);
  const page = (ids: number[], nextCursor?: string): SessionsCatalogReadResult => ({
    ...key,
    items: ids.map((id) => ({ id: String(id), type: "agentMessage", text: `answer ${id}` })),
    nextCursor,
  });
  let latest = page([4, 3, 2, 1], "stale-older");
  const cursors: Array<string | undefined> = [];
  vi.spyOn(client, "request").mockImplementation(async (method, ...args) => {
    if (method === "sessions.catalog.list") {
      return catalogList(key, [
        {
          threadId: key.threadId,
          status: "live",
          archived: false,
          canContinue: false,
          canArchive: false,
        },
      ]);
    }
    if (method === "sessions.catalog.read") {
      const cursor = (args[0] as { cursor?: string }).cursor;
      cursors.push(cursor);
      return cursor ? page([1]) : latest;
    }
    return original(method, ...args);
  });
  const pane = fixture.mount(buildCatalogSessionKey(key, "main"));
  await vi.waitFor(() => expect(pane.history.catalogMessages).toHaveLength(4));
  latest = page(latestIds, "fresh-older");
  await expect(pane.pollCatalogSession()).resolves.toBe(true);
  expect(pane.history.catalogMessages.map(catalogMessageId)).toEqual(
    latestIds.toReversed().map(String),
  );
  expect(pane.history.catalogCursor).toBe("fresh-older");
  await expect(pane.loadCatalogSession(key, true)).resolves.toBe(true);
  expect(cursors).toEqual([undefined, undefined, "fresh-older"]);
});
