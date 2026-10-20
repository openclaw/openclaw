import { expect, it, onTestFinished, vi } from "vitest";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogResult } from "../api/types.ts";
import { createGatewayStoreTestStore } from "../app/gateway-store.test-support.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import {
  clearModelCatalogCache,
  beginModelCatalogRead,
  publishModelCatalogResult,
} from "./model-catalog-cache.ts";
import { ModelCatalogReader } from "./model-catalog-reader.ts";
import { peekModelCatalog, subscribeModelCatalogCache } from "./model-catalog-store.ts";

const first = { models: [{ provider: "fixture", id: "first", name: "First" }] };
const second = { models: [{ provider: "fixture", id: "second", name: "Second" }] };

function fixture(scope: ModelsListParams = { agentId: "main" }) {
  const { gateway, current } = createGatewayStoreTestStore();
  gateway.start();
  current().opts.onHello?.(gatewayHelloForMethods([]));
  const client = gateway.snapshot.client;
  if (!client) {
    throw new Error("Expected connected fixture client");
  }
  const notify = vi.fn();
  const reader = new ModelCatalogReader(notify);
  reader.bind(gateway, scope);
  onTestFinished(() => {
    reader.clear();
    gateway.stop();
  });
  const publish = (target: ModelsListParams, result: ModelCatalogResult = first) =>
    publishModelCatalogResult(beginModelCatalogRead(client, target), target, result);
  const check = (calls: number, state: Partial<typeof reader.snapshot> = {}) => {
    expect(notify).toHaveBeenCalledTimes(calls);
    expect(reader.snapshot).toMatchObject(state);
    notify.mockClear();
  };
  const send = (
    target: ModelsListParams,
    result: ModelCatalogResult,
    calls = 1,
    state: Partial<typeof reader.snapshot> = {},
  ) => {
    publish(target, result);
    check(calls, state);
  };
  return { gateway, current, client, reader, notify, publish, scope, check, send };
}

it("keeps warm reader publications scoped while accepting own replacements, failed discovery and changed bindings", async () => {
  const { reader, notify, scope, gateway, client, current, send } = fixture();
  send(scope, first, 1, { models: first.models });
  for (const other of [
    { agentId: "other" },
    { agentId: "main", authProfileId: "personal:other" },
    { agentId: "main", sessionKey: "agent:main:other" },
  ]) {
    send(other, first, 0);
  }
  send(scope, second, 1, { models: second.models });
  send(scope, { ...first, refreshFailed: true }, 1, { refreshFailed: true });
  expect(peekModelCatalog(client, scope)).toBeUndefined();
  current().request.mockRejectedValueOnce(new Error("Synthetic failure"));
  await reader.read();
  expect(reader.failed).toBe(true);
  notify.mockClear();
  send(scope, second);
  expect(reader.failed).toBe(false);
  reader.bind(gateway, { agentId: "other" });
  notify.mockClear();
  send(scope, first, 0);
  send({ agentId: "other" }, second);
  reader.clear();
  notify.mockClear();
  send({ agentId: "other" }, first, 0);
});

it("notifies cold readers of first admission and restricted policy transitions, not every unrelated snapshot", () => {
  const { client, send, check } = fixture();
  clearModelCatalogCache(client, { requireSnapshot: true });
  check(1, { retired: true });
  send({ agentId: "other" }, first, 1, { retired: false, hasSnapshot: false });
  send({ agentId: "other" }, second, 0);
  send(
    { agentId: "other" },
    { ...second, modelSelectionPolicy: { restricted: true, defaultModel: "fixture/second" } },
    1,
    { retired: true },
  );
  send({ agentId: "other" }, first, 1, { retired: false });
});

it("preserves successful refresh invalidations, failed refresh isolation, eviction and connection clear", () => {
  const { client, notify, publish, scope, check } = fixture();
  publish(scope);
  publish({ agentId: "other" });
  notify.mockClear();
  publish({ agentId: "other", refresh: true }, { ...second, refreshFailed: true });
  check(0);
  expect(peekModelCatalog(client, scope)?.models[0]?.id).toBe("first");
  publish({ agentId: "other", refresh: true }, second);
  check(1, { models: first.models });
  expect(peekModelCatalog(client, scope)).toBeUndefined();
  clearModelCatalogCache(client);
  publish(scope);
  notify.mockClear();
  for (let index = 0; index < 64; index++) {
    publish({ agentId: "other-" + index });
  }
  check(1, { hasSnapshot: false });
  clearModelCatalogCache(client);
  check(1, { retired: true });
});

it("uses the current scoped subscription intent and keeps global observers global", () => {
  const { client, publish } = fixture();
  publish({ agentId: "main" });
  let scope = { agentId: " main " };
  const scoped = vi.fn();
  const global = vi.fn();
  const stopScoped = subscribeModelCatalogCache(client, scoped, () => scope);
  const stopGlobal = subscribeModelCatalogCache(client, global);
  onTestFinished(() => {
    stopScoped();
    stopGlobal();
  });
  publish({ agentId: "other" });
  expect(scoped).not.toHaveBeenCalled();
  expect(global).toHaveBeenCalledOnce();
  publish({ agentId: "main" });
  expect(scoped).toHaveBeenCalledOnce();
  scope = { agentId: "other" };
  publish({ agentId: "main" });
  expect(scoped).toHaveBeenCalledOnce();
  publish({ agentId: "other" });
  expect(scoped).toHaveBeenCalledTimes(2);
  stopScoped();
  stopScoped();
  publish({ agentId: "other" });
  expect(scoped).toHaveBeenCalledTimes(2);
  expect(global).toHaveBeenCalledTimes(5);
});
