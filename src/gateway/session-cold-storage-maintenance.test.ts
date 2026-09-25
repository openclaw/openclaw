import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  getSessionColdStorageMaintenanceStatus,
  requestGatewaySessionColdStorageMaintenance,
  startSessionColdStorageMaintenance,
} from "./session-cold-storage-maintenance.js";

const { sweep, inventory } = vi.hoisted(() => ({ sweep: vi.fn(), inventory: vi.fn() }));
vi.mock("../config/sessions/session-cold-storage.js", () => ({
  runSessionColdStorageMaintenance: sweep,
  getSessionColdStorageStatus: inventory,
}));

let maintenance: ReturnType<typeof startSessionColdStorageMaintenance> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  resetGatewayWorkAdmission();
  sweep.mockReset().mockResolvedValue({ archivedTranscripts: 2, externalizedTranscripts: 0 });
  inventory.mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  await maintenance?.stop();
  maintenance = undefined;
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

it("picks up enabled and changed age settings without recreating the scheduler", async () => {
  let config: OpenClawConfig = {};
  const getRuntimeConfig = () => config;
  maintenance = startSessionColdStorageMaintenance({ getRuntimeConfig, onError: vi.fn() });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sweep).not.toHaveBeenCalled();
  expect(() => requestGatewaySessionColdStorageMaintenance(getRuntimeConfig)).toThrow("disabled");

  config = { session: { maintenance: { coldStorage: { enabled: true, afterDays: 30 } } } };
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sweep).toHaveBeenLastCalledWith(expect.objectContaining({ config }));
  expect(getSessionColdStorageMaintenanceStatus(getRuntimeConfig)).toMatchObject({
    running: false,
    archivedTranscripts: 2,
    lastError: null,
  });

  config = { session: { maintenance: { coldStorage: { enabled: true, afterDays: 7 } } } };
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sweep).toHaveBeenLastCalledWith(expect.objectContaining({ config }));
  config = { session: { maintenance: { coldStorage: { enabled: false } } } };
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sweep).toHaveBeenCalledTimes(2);
});

it("coalesces manual and periodic work and rejects commits after a config change", async () => {
  let config: OpenClawConfig = {
    session: { maintenance: { coldStorage: { enabled: true, afterDays: 30 } } },
  };
  const getRuntimeConfig = () => config;
  const completion = createDeferred<{ archivedTranscripts: number }>();
  sweep.mockImplementation(async ({ assertCurrent }: { assertCurrent: () => void }) => {
    const result = await completion.promise;
    assertCurrent();
    return result;
  });
  const onError = vi.fn();
  maintenance = startSessionColdStorageMaintenance({ getRuntimeConfig, onError });
  await vi.advanceTimersByTimeAsync(0);
  requestGatewaySessionColdStorageMaintenance(getRuntimeConfig);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(sweep).toHaveBeenCalledTimes(1);

  config = { session: { maintenance: { coldStorage: { enabled: false } } } };
  completion.resolve({ archivedTranscripts: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledOnce();
  expect(getSessionColdStorageMaintenanceStatus(getRuntimeConfig)).toMatchObject({
    running: false,
    archivedTranscripts: 0,
    lastError: expect.stringContaining("canceled"),
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sweep).toHaveBeenCalledTimes(1);
});

it("waits for an admitted worker to relinquish its writer before shutdown completes", async () => {
  const config: OpenClawConfig = {
    session: { maintenance: { coldStorage: { enabled: true } } },
  };
  const completion = createDeferred<{ archivedTranscripts: number }>();
  sweep.mockImplementation(async ({ assertCurrent }: { assertCurrent: () => void }) => {
    const result = await completion.promise;
    assertCurrent();
    return result;
  });
  maintenance = startSessionColdStorageMaintenance({
    getRuntimeConfig: () => config,
    onError: vi.fn(),
  });
  await vi.advanceTimersByTimeAsync(0);
  let drained = false;
  const stopped = maintenance.stop().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  completion.resolve({ archivedTranscripts: 1 });
  await stopped;
  expect(drained).toBe(true);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sweep).toHaveBeenCalledTimes(1);
});

it("acknowledges Run now before worker completion and exposes committed progress after failure", async () => {
  const { sessionReadHandlers } = await import("./server-methods/sessions-read.js");
  let config: OpenClawConfig = {};
  const getRuntimeConfig = () => config;
  maintenance = startSessionColdStorageMaintenance({ getRuntimeConfig, onError: vi.fn() });
  config = { session: { maintenance: { coldStorage: { enabled: true } } } };
  const completion = createDeferred<{
    archivedTranscripts: number;
    externalizedTranscripts: number;
  }>();
  sweep.mockImplementation(
    async ({
      onProgress,
    }: {
      onProgress: (progress: {
        archivedTranscripts: number;
        externalizedTranscripts: number;
      }) => void;
    }) => {
      onProgress({ archivedTranscripts: 1, externalizedTranscripts: 2 });
      return await completion.promise;
    },
  );
  const respond = vi.fn();
  const request = sessionReadHandlers["sessions.storage.run"]!({
    params: {},
    context: { getRuntimeConfig },
    respond,
  } as never);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        maintenance: expect.objectContaining({ running: true }),
      }),
      undefined,
    );
    expect(sweep).toHaveBeenCalledOnce();
    completion.reject(new Error("second batch failed"));
    await request;
    await vi.advanceTimersByTimeAsync(0);
    expect(getSessionColdStorageMaintenanceStatus(getRuntimeConfig)).toMatchObject({
      running: false,
      archivedTranscripts: 1,
      externalizedTranscripts: 2,
      lastError: "second batch failed",
    });
    respond.mockClear();
    await sessionReadHandlers["sessions.storage.status"]!({
      params: {},
      context: { getRuntimeConfig },
      respond,
    } as never);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        maintenance: expect.objectContaining({
          running: false,
          archivedTranscripts: 1,
          externalizedTranscripts: 2,
          lastError: "second batch failed",
        }),
      }),
      undefined,
    );
  } finally {
    completion.resolve({ archivedTranscripts: 1, externalizedTranscripts: 2 });
  }
});

it("does not accept Run now if request authority expires during inventory", async () => {
  const { sessionReadHandlers } = await import("./server-methods/sessions-read.js");
  let config: OpenClawConfig = {};
  const getRuntimeConfig = () => config;
  maintenance = startSessionColdStorageMaintenance({ getRuntimeConfig, onError: vi.fn() });
  config = { session: { maintenance: { coldStorage: { enabled: true } } } };
  let current = true;
  inventory.mockImplementation(async () => {
    current = false;
    return [];
  });
  const respond = vi.fn();
  await sessionReadHandlers["sessions.storage.run"]!({
    params: {},
    context: { getRuntimeConfig },
    respond,
    hasCurrentClientAuthority: () => current,
  } as never);
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      message: expect.stringContaining("no longer authorized"),
    }),
  );
  expect(sweep).not.toHaveBeenCalled();
});
