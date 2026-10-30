import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  RestartSentinel,
  RestartSentinelPayload,
} from "../../infra/restart-sentinel-store.js";
import { createGatewayUpdateLifecycle } from "../../infra/update-check-lifecycle.js";
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

let lifecycle: ReturnType<typeof createGatewayUpdateLifecycle>;
beforeEach(() => {
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  store.read.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
});

async function status(sentinel?: RestartSentinelPayload) {
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
  if (sentinel) {
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ sentinel }));
  }
}

it.each(["disk", "empty", "published-during-read"])(
  "shares %s preparation without losing producer publications",
  async (source) => {
    const started = createDeferredCore();
    const read = createDeferredCore<RestartSentinel | null>();
    store.read.mockImplementationOnce(() => {
      started.resolve();
      return read.promise;
    });
    const payload = { kind: "update", status: "ok", ts: 1 } as const;
    const initial = {
      ...payload,
      status: source === "published-during-read" ? ("error" as const) : payload.status,
      ts: source === "empty" ? 0 : source === "disk" ? 1 : 20,
    };
    if (source === "empty") {
      recordLatestUpdateRestartSentinel(initial);
    }
    const clients = Array.from({ length: 20 }, () => status(initial));
    await started.promise;
    if (source === "published-during-read") {
      recordLatestUpdateRestartSentinel(initial);
    }
    read.resolve(source === "empty" ? null : { version: 1, revision: 1, payload });
    await Promise.all(clients);
    await status(initial);
    const published = { ...payload, status: "error", ts: 30 } as const;
    store.read.mockResolvedValue({ version: 1, revision: 2, payload: published });
    recordLatestUpdateRestartSentinel(published);
    await status(published);
    expect(store.read).toHaveBeenCalledOnce();

    await lifecycle.stop();
    await lifecycle.scheduler.stop();
    lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
    store.read.mockResolvedValue({ version: 1, revision: 3, payload: { ...payload, ts: 40 } });
    await status({ ...payload, ts: 40 });
    expect(store.read).toHaveBeenCalledTimes(2);
  },
);

it("retries failed preparation instead of retaining an unavailable snapshot", async () => {
  store.read.mockRejectedValueOnce(new Error("state unavailable"));
  await status();
  const payload = { kind: "update", status: "ok", ts: 30 } as const;
  store.read.mockResolvedValue({ version: 1, revision: 30, payload });
  await status(payload);
  expect(store.read).toHaveBeenCalledTimes(2);
});
