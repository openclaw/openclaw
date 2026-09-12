// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigPatchAck } from "./config-gateway-operations.ts";
import {
  createConfigCapabilityHarness,
  createConfigServerMock,
  deferred,
} from "./config-test-harness.ts";

it.each([false, true])(
  "runExternalMutation retires a held no-op read through refresh ownership (disconnect: %s)",
  async (disconnect) => {
    vi.useFakeTimers();
    const store = createConfigServerMock();
    const started = deferred<void>();
    const release = deferred<void>();
    let holdNextRead = false;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch") {
        return { noop: true, config: { count: 1 } };
      }
      if (method === "config.get" && holdNextRead) {
        holdNextRead = false;
        const snapshot = await store.request(method, params);
        started.resolve();
        await release.promise;
        return snapshot;
      }
      return store.request(method, params);
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    holdNextRead = true;
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
      expect(runtimeConfig.state.configFormDirty).toBe(false);
      expect(runtimeConfig.state.configAutoSaveStatus).not.toBe("conflict");
      expect(runtimeConfig.state.configDraftBaseHash).toBe(disconnect ? "hash-1" : "hash-2");
      if (!disconnect) {
        runtimeConfig.patchForm(["count"], 2);
        await expect(runtimeConfig.save()).resolves.toBe(true);
        expect(store.submissions.at(-1)).toMatchObject({ baseHash: "hash-2" });
        await expect(store.request("config.get")).resolves.toMatchObject({
          config: { count: 2, enabled: true },
        });
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
      }
    } finally {
      release.resolve();
      await mutation;
      runtimeConfig.dispose();
    }
  },
);

it("runExternalMutation preserves a retained form conflict after a hashless no-op", async () => {
  vi.useFakeTimers();
  const store = createConfigServerMock();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.patch") {
      return { noop: true, config: { count: 9 } };
    }
    if (
      method === "config.set" &&
      (params as { baseHash: string }).baseHash !== store.currentHash()
    ) {
      throw new Error("config changed since last load; re-run config.get and retry");
    }
    return store.request(method, params);
  });
  const { runtimeConfig } = createConfigCapabilityHarness(
    request as GatewayBrowserClient["request"],
  );
  await runtimeConfig.ensureLoaded();
  runtimeConfig.patchForm(["count"], 2);
  await store.request("config.set", { raw: '{"count":9}', baseHash: "hash-1" });
  await expect(runtimeConfig.save()).resolves.toBe(false);
  await runtimeConfig.refresh();
  expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
  const mutation = await runtimeConfig.runExternalMutation(
    (client) => client.request<ConfigPatchAck>("config.patch", { raw: '{"count":9}' }),
    { configWriteAck: (value) => value },
  );
  expect(mutation).toMatchObject({ ok: true, refresh: { ok: true } });
  const stateAfterNoop = {
    status: runtimeConfig.state.configAutoSaveStatus,
    base: runtimeConfig.state.configDraftBaseHash,
    original: runtimeConfig.state.configFormOriginal,
    form: runtimeConfig.state.configForm,
  };
  runtimeConfig.patchForm(["enabled"], true);
  const saved = await runtimeConfig.save();
  const final = await store.request("config.get");
  try {
    expect(stateAfterNoop).toMatchObject({
      status: "conflict",
      base: "hash-2",
      original: { count: 1 },
      form: { count: 2 },
    });
    expect(saved).toBe(false);
    expect(final).toMatchObject({ config: { count: 9 } });
    expect(store.submissions).toHaveLength(1);
  } finally {
    runtimeConfig.resetDraft();
    runtimeConfig.dispose();
  }
});

it("runExternalMutation replays a disjoint form edit made during the no-op source read", async () => {
  vi.useFakeTimers();
  const store = createConfigServerMock();
  const started = deferred<void>();
  const release = deferred<void>();
  let holdRead = false;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.patch") {
      holdRead = true;
      return { noop: true, config: { count: 1, enabled: true } };
    }
    const result = await store.request(method, params);
    if (method === "config.get" && holdRead) {
      holdRead = false;
      started.resolve();
      await release.promise;
    }
    return result;
  });
  const { runtimeConfig } = createConfigCapabilityHarness(
    request as GatewayBrowserClient["request"],
  );
  await runtimeConfig.ensureLoaded();
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
  await expect(store.request("config.get")).resolves.toMatchObject({
    config: { count: 2, enabled: true },
  });
  expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
  runtimeConfig.dispose();
});
