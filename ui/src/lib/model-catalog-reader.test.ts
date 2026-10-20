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
  return { gateway, current, client, reader, notify, publish, scope };
}

it("keeps warm reader publications scoped while accepting own replacements, failed discovery and changed bindings", async () => {
  const { reader, notify, publish, scope, gateway, client, current } = fixture();
  publish(scope);
  expect(reader.snapshot.models[0]?.id).toBe("first");
  notify.mockClear();
  for (const other of [
    { agentId: "other" },
    { agentId: "main", authProfileId: "personal:other" },
    { agentId: "main", sessionKey: "agent:main:other" },
  ]) {
    publish(other);
    expect(notify).not.toHaveBeenCalled();
  }
  publish(scope, second);
  expect(notify).toHaveBeenCalledOnce();
  expect(reader.snapshot.models[0]?.id).toBe("second");
  notify.mockClear();
  publish(scope, { ...first, refreshFailed: true });
  expect(notify).toHaveBeenCalledOnce();
  expect(reader.snapshot.refreshFailed).toBe(true);
  expect(peekModelCatalog(client, scope)).toBeUndefined();
  current().request.mockRejectedValueOnce(new Error("Synthetic failure"));
  await reader.read();
  expect(reader.failed).toBe(true);
  notify.mockClear();
  publish(scope, second);
  expect(reader.failed).toBe(false);
  expect(notify).toHaveBeenCalledOnce();
  reader.bind(gateway, { agentId: "other" });
  notify.mockClear();
  publish(scope);
  expect(notify).not.toHaveBeenCalled();
  publish({ agentId: "other" }, second);
  expect(notify).toHaveBeenCalledOnce();
  reader.clear();
  notify.mockClear();
  publish({ agentId: "other" });
  expect(notify).not.toHaveBeenCalled();
});

it("notifies cold readers of first admission and restricted policy transitions, not every unrelated snapshot", () => {
  const { client, reader, notify, publish } = fixture();
  clearModelCatalogCache(client, { requireSnapshot: true });
  expect(reader.snapshot.retired).toBe(true);
  notify.mockClear();
  publish({ agentId: "other" });
  expect(notify).toHaveBeenCalledOnce();
  expect(reader.snapshot.retired).toBe(false);
  expect(reader.snapshot.hasSnapshot).toBe(false);
  notify.mockClear();
  publish({ agentId: "other" }, second);
  expect(notify).not.toHaveBeenCalled();
  publish(
    { agentId: "other" },
    { ...second, modelSelectionPolicy: { restricted: true, defaultModel: "fixture/second" } },
  );
  expect(notify).toHaveBeenCalledOnce();
  expect(reader.snapshot.retired).toBe(true);
  notify.mockClear();
  publish({ agentId: "other" }, first);
  expect(notify).toHaveBeenCalledOnce();
  expect(reader.snapshot.retired).toBe(false);
});

it("preserves successful refresh invalidations, failed refresh isolation, eviction and connection clear", () => {
  const { client, reader, notify, publish, scope } = fixture();
  publish(scope);
  publish({ agentId: "other" });
  notify.mockClear();
  publish({ agentId: "other", refresh: true }, { ...second, refreshFailed: true });
  expect(notify).not.toHaveBeenCalled();
  expect(peekModelCatalog(client, scope)?.models[0]?.id).toBe("first");
  publish({ agentId: "other", refresh: true }, second);
  expect(notify).toHaveBeenCalledOnce();
  expect(peekModelCatalog(client, scope)).toBeUndefined();
  expect(reader.snapshot.models[0]?.id).toBe("first");
  clearModelCatalogCache(client);
  publish(scope);
  notify.mockClear();
  for (let index = 0; index < 64; index++) {
    publish({ agentId: "other-" + index });
  }
  expect(notify).toHaveBeenCalledOnce();
  expect(reader.snapshot.hasSnapshot).toBe(false);
  clearModelCatalogCache(client);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(reader.snapshot.retired).toBe(true);
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
