import { expect, it, onTestFinished, vi } from "vitest";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
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
const main = { agentId: "main" },
  other = { agentId: "other" };

function fixture(options?: ConstructorParameters<typeof ModelCatalogReader>[1]) {
  const { gateway, current } = createGatewayStoreTestStore();
  gateway.start();
  current().testOptions.onHello?.(gatewayHelloForMethods([]));
  const client = gateway.snapshot.client;
  if (!client) {
    throw new Error("Expected connected fixture client");
  }
  const notify = vi.fn(),
    reader = new ModelCatalogReader(notify, options);
  reader.bind(gateway, main);
  onTestFinished(() => {
    reader.clear();
    gateway.stop();
  });
  const take = () => {
    const state = { ...reader.snapshot, calls: notify.mock.calls.length, failed: reader.failed };
    notify.mockClear();
    return expect(state);
  };
  const publish = (target: ModelsListParams, result: ModelCatalogResult = first) => {
    publishModelCatalogResult(beginModelCatalogRead(client, target), target, result);
    return take();
  };
  return { gateway, current, client, reader, publish, take };
}

it("scopes warm publications and retires old bindings", async () => {
  const { reader, publish, gateway, client, current, take } = fixture();
  clearModelCatalogCache(client);
  take().toMatchObject({ retired: false, hasSnapshot: false, calls: 1 });
  publish(main).toMatchObject({ models: first.models, calls: 1 });
  for (const scope of [
    other,
    { ...main, authProfileId: "personal:other" },
    { ...main, sessionKey: "agent:main:other" },
  ]) {
    publish(scope).toMatchObject({ calls: 0 });
  }
  publish(main, second).toMatchObject({ models: second.models, calls: 1 });
  publish(main, { ...first, refreshFailed: true }).toMatchObject({
    refreshFailed: true,
    calls: 1,
  });
  expect(peekModelCatalog(client, main)).toBeUndefined();
  current().request.mockRejectedValueOnce(new Error("Synthetic failure"));
  await reader.read();
  take().toMatchObject({ failed: true });
  publish(main, second).toMatchObject({ failed: false, calls: 1 });
  reader.bind(gateway, other);
  publish(main).toMatchObject({ calls: 0 });
  publish(other, second).toMatchObject({ calls: 1 });
  reader.clear();
  publish(other).toMatchObject({ calls: 0 });
});

it("notifies cold readers only on admission and restricted policy transitions", () => {
  const { client, publish, take, reader, gateway } = fixture();
  clearModelCatalogCache(client, { requireSnapshot: true });
  take().toMatchObject({ retired: true, calls: 1 });
  publish(other).toMatchObject({ retired: false, hasSnapshot: false, calls: 1 });
  publish(other, second).toMatchObject({ calls: 0 });
  const restricted: ModelCatalogResult = {
    ...second,
    modelSelectionPolicy: { restricted: true, defaultModel: "fixture/second" },
  };
  publish(other, restricted).toMatchObject({ retired: true, calls: 1 });
  reader.bind(gateway, other);
  take().toMatchObject({ retired: false, hasSnapshot: true });
  reader.bind(gateway, main);
  publish(other).toMatchObject({ retired: false, calls: 1 });
});

it("isolates failed refreshes and preserves refresh, eviction, and clear notifications", () => {
  const { client, publish, take } = fixture();
  publish(main);
  publish(other);
  publish({ ...other, refresh: true }, { ...second, refreshFailed: true }).toMatchObject({
    calls: 0,
  });
  expect(peekModelCatalog(client, main)?.models[0]?.id).toBe("first");
  publish({ ...other, refresh: true }, second).toMatchObject({
    models: first.models,
    calls: 1,
  });
  expect(peekModelCatalog(client, main)).toBeUndefined();
  clearModelCatalogCache(client);
  publish(main);
  // Drain only at the end: the 64 publications together must trigger one eviction notification.
  for (let index = 0; index < 63; index++) {
    const target = { agentId: "other-" + index };
    publishModelCatalogResult(beginModelCatalogRead(client, target), target, first);
  }
  publish({ agentId: "other-63" }).toMatchObject({ hasSnapshot: false, calls: 1 });
  clearModelCatalogCache(client);
  take().toMatchObject({ retired: true, hasSnapshot: false, models: [], calls: 1 });
});

it("follows subscription intent while keeping global observers global", () => {
  const { client, publish, reader } = fixture();
  publish(main);
  let scope = { agentId: " main " };
  const scoped = vi.fn(),
    global = vi.fn();
  const stopScoped = subscribeModelCatalogCache(client, scoped, () => scope);
  const stopGlobal = subscribeModelCatalogCache(client, global);
  onTestFinished(() => {
    stopScoped();
    stopGlobal();
  });
  for (const [agentId, target, calls] of [
    [" main ", other, 0],
    [" main ", main, 1],
    ["other", main, 1],
    ["other", other, 2],
  ] as const) {
    scope = { agentId };
    publish(target);
    expect(scoped).toHaveBeenCalledTimes(calls);
    if (calls === 0) {
      expect(global).toHaveBeenCalledOnce();
    }
  }
  stopScoped();
  stopScoped();
  publish(other);
  expect(scoped).toHaveBeenCalledTimes(2);
  expect(global).toHaveBeenCalledTimes(5);
  reader.clear();
  stopGlobal();
});

it("observes each admitted read while preserving the non-throwing request contract", async () => {
  const onRead = vi.fn<(read: Promise<ModelCatalogResult | undefined>) => void>();
  const { reader, current, publish, client } = fixture({ onRead });
  const failure = new Error("Synthetic catalog failure");
  current().request.mockRejectedValueOnce(failure);
  const legacy = reader.read();
  const observed = onRead.mock.calls[0]![0];
  await expect(observed).rejects.toBe(failure);
  await expect(legacy).resolves.toBeUndefined();
  expect(reader.failed).toBe(true);

  publish(main);
  await expect(reader.read()).resolves.toEqual(first);
  await expect(onRead.mock.calls[1]![0]).resolves.toEqual(first);
  clearModelCatalogCache(client);
  const pending = createDeferred<ModelCatalogResult>();
  current().request.mockReturnValueOnce(pending.promise);
  const retired = reader.read();
  reader.clear();
  pending.reject(failure);
  await expect(onRead.mock.calls[2]![0]).resolves.toBeUndefined();
  await expect(retired).resolves.toBeUndefined();
  expect(onRead).toHaveBeenCalledTimes(3);
});
