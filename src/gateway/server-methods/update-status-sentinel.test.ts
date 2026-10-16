import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RestartSentinel } from "../../infra/restart-sentinel-store.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { recordLatestUpdateRestartSentinel } from "../server-update-sentinel.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { updateStatusHandlers } from "./update-status.js";

const store = vi.hoisted(() => ({ read: vi.fn<() => Promise<RestartSentinel | null>>() }));
vi.mock("../../infra/restart-sentinel.js", async (original) => ({
  ...(await original<typeof import("../../infra/restart-sentinel.js")>()),
  readRestartSentinel: store.read,
  readRestartSentinelSnapshot: async () => {
    const sentinel = await store.read();
    return { sentinel, revision: sentinel?.revision ?? null };
  },
  finalizeUpdateRestartSentinelRunningVersion: async () => null,
}));
vi.mock("../../infra/ocm-update-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/ocm-update-client.js")>()),
  resolveOcmUpdateManager: async () => null,
}));
vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-ledger.js")>()),
  reconcileAbandonedUpdateRunsAsync: async () => [],
  getUpdateRunStatusAsync: async () => ({}),
}));
vi.mock("../../infra/update-status-schedule.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-status-schedule.js")>()),
  getGatewayUpdateSchedule: () => ({ channel: "stable", autoEnabled: false }),
}));

let lifecycle: UpdateCheckLifecycle;
beforeEach(() => {
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  store.read.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
});

async function status() {
  const respond = vi.fn<RespondFn>();
  await updateStatusHandlers["update.status"]!({
    req: { type: "req", id: "status", method: "update.status", params: {} },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeConfig: () => ({ update: { channel: "stable" } }),
    } as GatewayRequestContext,
  });
  return respond;
}

it.each([false, true])(
  "shares cold sentinel preparation and later publications (empty=%s)",
  async (empty) => {
    const started = createDeferredCore();
    const read = createDeferredCore<RestartSentinel | null>();
    store.read.mockImplementation(() => {
      started.resolve();
      return read.promise;
    });
    const payload = { kind: "update", status: "ok", ts: 1 } as const;
    const initial = empty ? { ...payload, ts: 0 } : payload;
    if (empty) {
      recordLatestUpdateRestartSentinel(initial);
    }
    const clients = Array.from({ length: 20 }, () => status());
    await started.promise;
    read.resolve(empty ? null : { version: 1, revision: 1, payload });
    for (const respond of await Promise.all(clients)) {
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ sentinel: initial }));
    }
    const published = { ...payload, status: "error", ts: 2 } as const;
    store.read.mockResolvedValue({ version: 1, revision: 2, payload: published });
    recordLatestUpdateRestartSentinel(published);
    expect(await status()).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sentinel: published }),
    );
    expect(store.read).toHaveBeenCalledOnce();

    await lifecycle.stop();
    await lifecycle.scheduler.stop();
    lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
    store.read.mockResolvedValue({ version: 1, revision: 3, payload: { ...payload, ts: 3 } });
    expect(await status()).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sentinel: { ...payload, ts: 3 } }),
    );
    expect(store.read).toHaveBeenCalledTimes(2);
  },
);

it("does not replace a producer publication with a late initial read", async () => {
  const started = createDeferredCore();
  const read = createDeferredCore<RestartSentinel | null>();
  store.read.mockImplementationOnce(() => {
    started.resolve();
    return read.promise;
  });
  const request = status();
  await started.promise;
  const current = { kind: "update", status: "error", ts: 20 } as const;
  recordLatestUpdateRestartSentinel(current);
  read.resolve({ version: 1, revision: 10, payload: { ...current, status: "ok", ts: 10 } });
  expect(await request).toHaveBeenCalledWith(true, expect.objectContaining({ sentinel: current }));
  expect(await status()).toHaveBeenCalledWith(true, expect.objectContaining({ sentinel: current }));
  expect(store.read).toHaveBeenCalledOnce();
});

it("retries failed preparation instead of retaining an unavailable snapshot", async () => {
  store.read.mockRejectedValueOnce(new Error("state unavailable"));
  await status();
  const payload = { kind: "update", status: "ok", ts: 30 } as const;
  store.read.mockResolvedValue({ version: 1, revision: 30, payload });
  expect(await status()).toHaveBeenCalledWith(true, expect.objectContaining({ sentinel: payload }));
  expect(store.read).toHaveBeenCalledTimes(2);
});
