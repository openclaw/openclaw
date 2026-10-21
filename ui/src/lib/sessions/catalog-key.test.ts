import { expect, it, vi } from "vitest";
import {
  buildCatalogSessionKey,
  catalogSessionKeyFromSearch,
  catalogSessionSearch,
  lookupCatalogSession,
  parseCatalogSessionKey,
} from "./catalog-key.ts";

function page(sessions: Array<{ threadId: string }>, nextCursor?: string) {
  const host = {
    hostId: "gateway:local",
    sessions,
    nextCursor,
  };
  return { catalogs: [{ id: "codex", hosts: [host] }] };
}

it.each([undefined, "other"])("round-trips opaque source ids for owner %s", (agentId) => {
  const key = { catalogId: "fixture", hostId: "node:DevBox", threadId: "Thread:A/B" };
  expect(parseCatalogSessionKey(buildCatalogSessionKey(key, agentId))).toEqual(key);
});

it.each([
  "",
  "catalog:",
  "catalog:a:b",
  "catalog:a:b:c:d",
  "catalog:a:%:c",
  "catalog::b:c",
  "catalog:a::c",
  "catalog:a:b:",
])("rejects %s", (value) => expect(parseCatalogSessionKey(value)).toBeNull());

it.each([undefined, "home:a/b"])(
  "round-trips a catalog thread URL target for source %s",
  (sourceHomeId) => {
    const key = {
      catalogId: "claude",
      hostId: "node:abc",
      threadId: "thread:a/b",
      ...(sourceHomeId ? { sourceHomeId } : {}),
    };
    expect(catalogSessionKeyFromSearch(catalogSessionSearch(key))).toEqual(key);
  },
);

it("keeps the explicit agent owner across paginated lookup requests", async () => {
  const key = { catalogId: "codex", hostId: "gateway:local", threadId: "thread-2" };
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([], "next"))
    .mockResolvedValueOnce(page([{ threadId: "thread-2" }]));

  const result = await lookupCatalogSession({
    client: { request } as never,
    key,
    agentId: "jarvis",
    isCurrent: () => true,
  });

  expect(result?.session?.threadId).toBe("thread-2");
  const params = {
    agentId: "jarvis",
    catalogId: "codex",
    hostIds: ["gateway:local"],
    limitPerHost: 100,
  };
  expect(request).toHaveBeenNthCalledWith(1, "sessions.catalog.list", params);
  expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
    ...params,
    cursors: { "gateway:local": "next" },
  });
});
