import { beforeEach, expect, it, vi } from "vitest";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import {
  catalogHost,
  catalogProvider,
  expectCatalog,
} from "./session-catalog.fixtures.test-support.js";
import { call, hoisted, resetSessionCatalogTestState } from "./session-catalog.test-helpers.js";

beforeEach(resetSessionCatalogTestState);

it("separates shared queries while leaving local listing to its existing client-side filter", async () => {
  const list = vi.fn<SessionCatalogProvider["list"]>(async () => [catalogHost()]);
  const read = vi.fn<SessionCatalogProvider["read"]>(async ({ hostId, threadId }) => ({
    hostId,
    threadId,
    items: [],
  }));
  const provider = catalogProvider("shared", { supportsProfileRelation: true, list, read });
  hoisted.activeRegistry.sessionCatalogs = [{ provider }];
  const owned = {
    relationship: "owned",
    target: { type: "profile", id: "source-profile" },
  } as const;
  const involved = { ...owned, relationship: "involving" } as const;
  for (const profileRelation of [owned, involved]) {
    const result = await call("sessions.catalog.list", { catalogId: "shared", profileRelation });
    expectCatalog(result, {
      profileRelation,
      capabilities: expect.objectContaining({ profileRelation: true }),
    });
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ profileRelation }));
  }
  expect(list).toHaveBeenCalledTimes(2);
  const request = {
    catalogId: "shared",
    hostId: "gateway:local",
    threadId: "thread",
    profileRelation: owned,
  };
  const result = await call("sessions.catalog.read", request);
  expect(result).toHaveBeenCalledWith(true, expect.objectContaining({ items: [] }));
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ profileRelation: owned }));
  provider.supportsProfileRelation = undefined;
  list.mockClear();
  read.mockClear();
  const localResult = await call("sessions.catalog.list", {
    catalogId: "shared",
    profileRelation: owned,
  });
  expectCatalog(localResult, { id: "shared" });
  expect(localResult.mock.calls[0]?.[1]?.catalogs[0]).not.toHaveProperty("profileRelation");
  await call("sessions.catalog.read", request);
  expect(list).toHaveBeenCalledOnce();
  expect(list.mock.calls[0]?.[0]).not.toHaveProperty("profileRelation");
  expect(read).not.toHaveBeenCalled();
});

it("keeps local catalogs available when a shared relationship cannot resolve", async () => {
  const localList = vi.fn<SessionCatalogProvider["list"]>(async () => [catalogHost()]);
  const sharedList = vi.fn<SessionCatalogProvider["list"]>(async () => [catalogHost()]);
  hoisted.activeRegistry.sessionCatalogs = [
    { provider: catalogProvider("local", { list: localList }) },
    { provider: catalogProvider("shared", { supportsProfileRelation: true, list: sharedList }) },
  ];
  const respond = await call("sessions.catalog.list", {
    profileRelation: { relationship: "involving", target: { type: "me" } },
  });
  expect(respond).toHaveBeenCalledWith(true, {
    catalogs: expect.arrayContaining([
      expect.objectContaining({
        id: "local",
        hosts: [expect.objectContaining({ hostId: "gateway:local" })],
      }),
      expect.objectContaining({
        id: "shared",
        error: expect.objectContaining({ message: expect.stringContaining("authenticated human") }),
      }),
    ]),
  });
  expect(localList).toHaveBeenCalledOnce();
  expect(localList.mock.calls[0]?.[0]).not.toHaveProperty("profileRelation");
  expect(sharedList).not.toHaveBeenCalled();
});
