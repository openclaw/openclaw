/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import { catalogPage } from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { refetchExpandedSessionCatalogPages } from "./app-sidebar-session-catalog-state.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

const loading = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release, started: false };
});
vi.mock("./app-sidebar-session-catalog-pages.runtime.ts", async (original) => {
  loading.started = true;
  await loading.promise;
  return original();
});

it("skips the replay runtime for head-only reads and rechecks admission after loading", async () => {
  onTestFinished(loading.release);
  const head = catalogPage([{ threadId: "head", name: "Authorized head" }], "next");
  const catalog = head.catalogs[0]!;
  catalog.requiresFreshList = true;
  const host = catalog.hosts[0]!;
  const request = createGatewayRequestMock().mockResolvedValue(
    catalogPage([{ threadId: "deep", name: "Authorized deep" }]),
  );
  const client = createTestGatewayClient(request);
  let current = true;
  const params = {
    catalogs: head.catalogs,
    previousCatalogs: [],
    client,
    agentId: "main",
    pageDepths: new Map<string, number>(),
    isCurrent: () => current,
    canRequestPage: () => current,
  };
  expect(await refetchExpandedSessionCatalogPages(params)).toEqual(head.catalogs);
  expect(loading.started).toBe(false);
  const pending = refetchExpandedSessionCatalogPages({
    ...params,
    pageDepths: new Map([[sessionCatalogHostKey(catalog.id, host.hostId), 1]]),
  });
  await expect.poll(() => loading.started).toBe(true);
  current = false;
  loading.release();
  expect(await pending).toEqual(head.catalogs);
  expect(request).not.toHaveBeenCalled();
});
