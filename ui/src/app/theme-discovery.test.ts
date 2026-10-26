import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../test-helpers/application-context-fixtures.ts";
import { createThemeDiscovery } from "./theme-discovery.ts";

const owners: ReturnType<typeof createThemeDiscovery>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.dispose();
  }
});
function fixture() {
  const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
  const request = vi.spyOn(client, "request");
  const snapshot = createApplicationGatewaySnapshot({
    client,
    phase: "connected",
    selfUser: { id: "alice" },
  });
  const source = createApplicationGateway(snapshot);
  const refresh = vi.fn();
  const owner = createThemeDiscovery(source.gateway, refresh);
  owners.push(owner);
  return { ...source, client, request, snapshot, owner, refresh };
}

it("keeps newer searches and retires private feedback when the profile changes", async () => {
  const { owner, request, publish, snapshot, refresh } = fixture();
  const old = createDeferred<unknown>();
  request.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ items: [], nextCursor: null });
  const previous = owner.browse("old");
  await owner.browse("new");
  old.resolve({ items: [{ id: "old/theme" }], nextCursor: "old" });
  await previous;
  expect(owner.snapshot).toMatchObject({
    query: "new",
    page: { items: [], nextCursor: null },
    loading: false,
  });
  const mutation = createDeferred<unknown>();
  request.mockReturnValueOnce(mutation.promise);
  const pending = owner.mutate("install", "studio/aurora", "1.0.0");
  publish({ ...snapshot, selfUser: { id: "bob" } });
  mutation.resolve({ application: "saved" });
  await pending;
  expect(refresh).not.toHaveBeenCalled();
  expect(owner.snapshot).toMatchObject({ page: null, mutation: null, saved: null, error: null });
});

it("retains prior pages and settles installation independently of browsing", async () => {
  const { owner, request, refresh } = fixture();
  request.mockResolvedValueOnce({ items: [{ id: "studio/one" }], nextCursor: "next" });
  await owner.browse();
  const mutation = createDeferred<unknown>();
  request.mockReturnValueOnce(mutation.promise);
  const pending = owner.mutate("install", "studio/one", "1.0.0");
  request.mockResolvedValueOnce({ items: [{ id: "studio/two" }], nextCursor: null });
  await owner.browse("", "next");
  mutation.resolve({ application: "saved" });
  await pending;
  expect(owner.snapshot.page?.items.map((item) => item.id)).toEqual(["studio/one", "studio/two"]);
  expect(owner.snapshot).toMatchObject({ mutation: null, saved: "install" });
  expect(refresh).toHaveBeenCalledOnce();
  request.mockRejectedValueOnce(new Error("Cannot remove theme"));
  await owner.mutate("remove", "user/test");
  expect(owner.snapshot).toMatchObject({
    error: "Cannot remove theme",
    mutation: null,
    saved: null,
  });
});
