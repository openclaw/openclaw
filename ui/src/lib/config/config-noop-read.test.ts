// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ConfigPatchAck } from "./config-draft-model.ts";
import {
  createPatchServer,
  expectStoredConfig,
  loadedConfig,
} from "./config-suite.test-support.ts";
import { createConfigServerMock } from "./config-test-harness.ts";

beforeEach(() => vi.useFakeTimers());

async function heldNoopRead(config: Record<string, unknown>) {
  const store = createConfigServerMock();
  const started = deferred();
  const release = deferred();
  let holdRead = false;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.patch") {
      holdRead = true;
      return { noop: true, config };
    }
    const result = await store.request(method, params);
    if (method === "config.get" && holdRead) {
      holdRead = false;
      started.resolve();
      await release.promise;
    }
    return result;
  });
  return { store, started, release, ...(await loadedConfig(request)) };
}

it.each([false, true])(
  "runExternalMutation retires a held no-op read through refresh ownership (disconnect: %s)",
  async (disconnect) => {
    const { store, started, release, ...harness } = await heldNoopRead({ count: 1 });
    const { runtimeConfig, publish, state } = harness;
    const mutation = runtimeConfig.runExternalMutation(
      (client) => client.request<ConfigPatchAck>("config.patch", { raw: '{"count":1}' }),
      { configWriteAck: (value) => value },
    );
    let outcome: Awaited<typeof mutation> | undefined;
    void mutation.then((result) => {
      outcome = result;
    });
    await started.promise;
    try {
      if (disconnect) {
        publish(false);
      } else {
        await store.request("config.set", {
          raw: '{"count":1,"enabled":true}',
          baseHash: "hash-1",
        });
        await runtimeConfig.refresh();
      }
      await vi.advanceTimersByTimeAsync(0);
      if (disconnect) {
        expect(outcome).toMatchObject({ ok: true, refresh: { ok: false } });
      }
      release.resolve();
      await mutation;
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toMatchObject({ ok: true, refresh: { ok: !disconnect } });
      expect(state).toMatchObject({
        configFormDirty: false,
        configDraftBaseHash: disconnect ? "hash-1" : "hash-2",
      });
      expect(state.configAutoSaveStatus).not.toBe("conflict");
      if (!disconnect) {
        runtimeConfig.patchForm(["count"], 2);
        await expect(runtimeConfig.save()).resolves.toBe(true);
        expect(store.submissions.at(-1)).toMatchObject({ baseHash: "hash-2" });
        await expectStoredConfig(store, { count: 2, enabled: true });
        expect(state.configAutoSaveStatus).toBe("saved");
      }
    } finally {
      release.resolve();
      await mutation;
    }
  },
);

it("runExternalMutation preserves a retained form conflict after a hashless no-op", async () => {
  const { store, request } = createPatchServer();
  const { runtimeConfig, state } = await loadedConfig(request, true);
  runtimeConfig.patchForm(["count"], 2);
  await store.request("config.set", { raw: '{"count":9}', baseHash: "hash-1" });
  await expect(runtimeConfig.save()).resolves.toBe(false);
  await runtimeConfig.refresh();
  expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
  const mutation = await runtimeConfig.runExternalMutation(
    (client) =>
      client.request<ConfigPatchAck>("config.patch", { raw: '{"count":9}', baseHash: "hash-2" }),
    { configWriteAck: (value) => value },
  );
  expect(mutation).toMatchObject({ ok: true, refresh: { ok: true } });
  expect(state).toMatchObject({
    configAutoSaveStatus: "conflict",
    configDraftBaseHash: "hash-2",
    configFormOriginal: { count: 1 },
    configForm: { count: 2 },
  });
  runtimeConfig.patchForm(["enabled"], true);
  await expect(runtimeConfig.save()).resolves.toBe(false);
  await expectStoredConfig(store, { count: 9 });
  expect(store.submissions).toHaveLength(1);
});

it("runExternalMutation replays a disjoint form edit made during the no-op source read", async () => {
  const { store, started, release, ...harness } = await heldNoopRead({ count: 1, enabled: true });
  const { runtimeConfig, state } = harness;
  await store.request("config.set", { raw: '{"count":1,"enabled":true}', baseHash: "hash-1" });
  const mutation = runtimeConfig.runExternalMutation(
    (client) => client.request<ConfigPatchAck>("config.patch", { raw: '{"enabled":true}' }),
    { configWriteAck: (value) => value },
  );
  await started.promise;
  runtimeConfig.patchForm(["count"], 2);
  const save = runtimeConfig.save();
  release.resolve();
  await expect(mutation).resolves.toMatchObject({ ok: true, refresh: { ok: true } });
  await expect(save).resolves.toBe(true);
  expect(store.submissions.at(-1)).toMatchObject({ baseHash: "hash-2" });
  await expectStoredConfig(store, { count: 2, enabled: true });
  expect(state.configAutoSaveStatus).toBe("saved");
});
