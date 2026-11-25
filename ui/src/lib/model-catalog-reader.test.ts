import { expect, it, onTestFinished, vi } from "vitest";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ModelCatalogResult } from "../api/types.ts";
import { createGatewayStoreTestStore } from "../app/gateway-store.test-support.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { invalidateChatMetadataStore } from "./chat/chat-metadata-cache.ts";
import {
  clearModelCatalogCache,
  beginModelCatalogRead,
  publishModelCatalogResult,
  invalidateModelCatalogCache,
} from "./model-catalog-cache.ts";
import { ModelCatalogReader } from "./model-catalog-reader.ts";
import {
  loadModelCatalog,
  peekModelCatalog,
  subscribeModelCatalogCache,
} from "./model-catalog-store.ts";

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

it.each([false, true])(
  "coalesces paired catalog notices across readers (reply still pending: %s)",
  async (stillPending) => {
    const received = vi.fn();
    const { gateway, reader, current, client } = fixture({ onResult: received });
    const sibling = new ModelCatalogReader(() => {}, { onResult: received });
    sibling.bind(gateway, main);
    onTestFinished(() => sibling.clear());
    const previous = createDeferred<ModelCatalogResult>();
    const replacement = createDeferred<ModelCatalogResult>();
    const final = createDeferred<ModelCatalogResult>();
    const wire = current()
      .request.mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(replacement.promise)
      .mockReturnValueOnce(final.promise);
    const direct = loadModelCatalog(client, main);
    void reader.read();
    void sibling.read();
    expect(wire).toHaveBeenCalledTimes(1);
    const notify = (pendingOnly: boolean) => {
      // The application invalidates the store before notifying mounted views.
      invalidateChatMetadataStore(
        client,
        pendingOnly ? undefined : main,
        undefined,
        pendingOnly ? "pending" : "refresh",
        { commandsChanged: false },
      );
      current().testOptions.onEvent?.({
        type: "event",
        event: "chat.metadata.changed",
        payload: pendingOnly
          ? { modelCatalogChanged: false, modelCatalogStatusChanged: true }
          : { ...main, modelCatalogChanged: true },
      });
    };
    notify(false);
    notify(true);
    notify(true);
    expect(wire).toHaveBeenCalledTimes(2);
    replacement.resolve(stillPending ? { ...first, pendingProviders: ["fixture"] } : second);
    if (stillPending) {
      await vi.waitFor(() => expect(wire).toHaveBeenCalledTimes(3));
      expect(received).not.toHaveBeenCalled();
      final.resolve(second);
    }
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2));
    await expect(direct).resolves.toEqual(second);
    previous.reject(new Error("Retired catalog failed"));
    await Promise.resolve();
    expect(received.mock.calls).toEqual([[second], [second]]);
    expect(peekModelCatalog(client, main)).toEqual(second);
    expect(wire).toHaveBeenCalledTimes(stillPending ? 3 : 2);
  },
);

it("displays the partial receipt if another status notice lands during its recheck", async () => {
  const { current, client } = fixture();
  const pending = { ...first, pendingProviders: ["fixture"] };
  const original = createDeferred<ModelCatalogResult>();
  const recheck = createDeferred<ModelCatalogResult>();
  const wire = current()
    .request.mockReturnValueOnce(original.promise)
    .mockReturnValueOnce(recheck.promise)
    .mockResolvedValueOnce(second);
  const display = loadModelCatalog(client, main);
  invalidateChatMetadataStore(client, undefined, undefined, "pending");
  original.resolve(pending);
  await vi.waitFor(() => expect(wire).toHaveBeenCalledTimes(2));
  invalidateChatMetadataStore(client, undefined, undefined, "pending");
  recheck.resolve(pending);
  await expect(display).resolves.toEqual(pending);
  expect(peekModelCatalog(client, main, { allowStale: true })).toEqual(pending);
  expect(peekModelCatalog(client, main)).toBeUndefined();
  await expect(loadModelCatalog(client, main)).resolves.toEqual(second);
  expect(wire).toHaveBeenCalledTimes(3);
});

it("keeps the outcome of explicit discovery when its status changes during the request", async () => {
  const { current, client } = fixture();
  const wire = createDeferred<ModelCatalogResult>();
  const result = { ...first, pendingProviders: ["fixture"] };
  current().request.mockReturnValueOnce(wire.promise);
  const discovery = loadModelCatalog(client, { ...main, refresh: true });
  invalidateChatMetadataStore(client, undefined, undefined, "pending");
  wire.resolve(result);
  await expect(discovery).resolves.toEqual(result);
  expect(current().request).toHaveBeenCalledTimes(1);
});

it.each(["document", "presentation"] as const)(
  "defers hidden %s catalog changes and catches up once on reveal",
  async (hiddenBy) => {
    let visible = true;
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => (hiddenBy === "document" && !visible ? "hidden" : "visible"));
    onTestFinished(() => visibility.mockRestore());
    const onRead = vi.fn<(read: Promise<ModelCatalogResult | undefined>) => void>();
    const { reader, client, current } = fixture({
      isPresented: () => hiddenBy !== "presentation" || visible,
      onRead,
    });
    current().request.mockResolvedValue(first);
    await reader.read();
    current().request.mockClear();
    onRead.mockClear();
    visible = false;
    current().request.mockResolvedValue(second);
    for (let index = 0; index < 60; index++) {
      invalidateModelCatalogCache(client, main);
      current().testOptions.onEvent?.({
        type: "event",
        event: "chat.metadata.changed",
        payload: { modelCatalogChanged: true, commandsChanged: false, authChanged: false },
      });
    }
    expect(current().request).not.toHaveBeenCalled();
    expect(onRead).not.toHaveBeenCalled();
    visible = true;
    if (hiddenBy === "document") {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    } else {
      reader.resume();
      reader.resume();
    }
    await onRead.mock.calls[0]![0];
    expect(current().request).toHaveBeenCalledTimes(1);
    expect(reader.snapshot.models).toEqual(second.models);
    expect(onRead).toHaveBeenCalledOnce();
  },
);
