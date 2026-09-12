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
