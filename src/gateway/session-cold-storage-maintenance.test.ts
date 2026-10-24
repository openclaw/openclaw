import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { sessionMaintenanceHandlers } from "./server-methods/sessions-maintenance.js";
import {
  getSessionColdStorageMaintenanceStatus,
  requestGatewaySessionColdStorageMaintenance,
  startSessionColdStorageMaintenance,
} from "./session-cold-storage-maintenance.js";

const { sweep, inventory } = vi.hoisted(() => ({ sweep: vi.fn(), inventory: vi.fn() }));
vi.mock("../config/sessions/session-cold-storage.js", () => ({
  runSessionColdStorageMaintenance: sweep,
}));

vi.mock("../config/sessions/session-cold-storage-status.js", () => ({
  getSessionColdStorageStatus: inventory,
}));
vi.mock("../config/sessions.js", () => ({
  runSessionsCleanup: vi.fn(),
  serializeSessionCleanupResult: vi.fn(),
}));
vi.mock("./server-methods/session-change-event.js", () => ({ emitSessionsChanged: vi.fn() }));

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: GatewayScheduler;
let maintenance: ReturnType<typeof startSessionColdStorageMaintenance>;
let config: OpenClawConfig;
const getRuntimeConfig = () => config;
const onError = vi.fn();
beforeEach(() => {
  config = { session: { maintenance: { coldStorage: { enabled: true } } } };
  onError.mockReset();
  clock = createGatewaySchedulerClock();
  scheduler = createTestGatewayScheduler(clock.clock);
  resetGatewayWorkAdmission();
  sweep.mockReset().mockResolvedValue({ archivedTranscripts: 2, externalizedTranscripts: 0 });
  inventory.mockReset().mockResolvedValue([]);
  maintenance = startSessionColdStorageMaintenance({ scheduler, getRuntimeConfig, onError });
});
afterEach(async () => {
  await maintenance?.stop();
  resetGatewayWorkAdmission();
  await scheduler.stop();
});

function blockSweep() {
  const completion = createDeferred<{ archivedTranscripts: number }>();
  const started = createDeferred();
  sweep.mockImplementation(async ({ assertCurrent }: { assertCurrent: () => void }) => {
    started.resolve();
    const result = await completion.promise;
    assertCurrent();
    return result;
  });
  return { completion, started };
}

async function invoke(
  method: keyof typeof sessionMaintenanceHandlers,
  hasCurrentClientAuthority?: () => boolean,
) {
  const respond = vi.fn();
  await sessionMaintenanceHandlers[method]!({
    params: {},
    context: { getRuntimeConfig },
    respond,
    hasCurrentClientAuthority,
  } as never);
  return respond;
}

function expectProgress(respond: ReturnType<typeof vi.fn>, progress: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ maintenance: expect.objectContaining(progress) }),
    undefined,
  );
}

it("picks up enabled and changed age settings without recreating the scheduler", async () => {
  config = {};
  await clock.advanceBy(60_000);
  expect(sweep).not.toHaveBeenCalled();
  expect(() => requestGatewaySessionColdStorageMaintenance(getRuntimeConfig)).toThrow("disabled");

  config = { session: { maintenance: { coldStorage: { enabled: true, afterDays: 30 } } } };
  await clock.advanceBy(60_000);
  expect(sweep).toHaveBeenLastCalledWith(expect.objectContaining({ config }));
  expect(getSessionColdStorageMaintenanceStatus(getRuntimeConfig)).toMatchObject({
    running: false,
    archivedTranscripts: 2,
    lastError: null,
  });

  config = { session: { maintenance: { coldStorage: { enabled: true, afterDays: 7 } } } };
  await clock.advanceBy(60_000);
  expect(sweep).toHaveBeenLastCalledWith(expect.objectContaining({ config }));
  config = { session: { maintenance: { coldStorage: { enabled: false } } } };
  await clock.advanceBy(60_000);
  expect(sweep).toHaveBeenCalledTimes(2);
});

it.each([
  ["periodic", "config"],
  ["periodic", "shutdown"],
  ["manual", "shutdown"],
] as const)("drains a %s sweep after %s cancellation", async (trigger, cancellation) => {
  if (cancellation === "config") {
    config = { session: { maintenance: { coldStorage: { enabled: true, afterDays: 30 } } } };
  }
  const { completion, started } = blockSweep();
  const running =
    trigger === "manual"
      ? requestGatewaySessionColdStorageMaintenance(getRuntimeConfig)
      : clock.wake();
  if (cancellation === "config") {
    requestGatewaySessionColdStorageMaintenance(getRuntimeConfig);
    void clock.advanceBy(180_000);
  }
  await started.promise;
  expect(sweep).toHaveBeenCalledTimes(1);
  if (cancellation === "config") {
    config = { session: { maintenance: { coldStorage: { enabled: false } } } };
    completion.resolve({ archivedTranscripts: 1 });
    await running;
    expect(onError).toHaveBeenCalledOnce();
    expect(getSessionColdStorageMaintenanceStatus(getRuntimeConfig)).toMatchObject({
      running: false,
      archivedTranscripts: 0,
      lastError: expect.stringContaining("canceled"),
    });
  } else {
    const drained = vi.fn();
    const stopped = maintenance.stop().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    completion.resolve({ archivedTranscripts: 1 });
    await stopped;
    expect(drained).toHaveBeenCalledOnce();
  }
  await clock.advanceBy(cancellation === "config" ? 60_000 : 120_000);
  expect(sweep).toHaveBeenCalledTimes(1);
});

it("acknowledges Run now before worker completion and exposes committed progress after failure", async () => {
  const progress = { archivedTranscripts: 1, externalizedTranscripts: 2 };
  const completion = createDeferred<typeof progress>();
  const started = createDeferred();
  sweep.mockImplementation(
    async ({ onProgress }: { onProgress: (value: typeof progress) => void }) => {
      onProgress(progress);
      started.resolve();
      return completion.promise;
    },
  );
  const request = invoke("sessions.storage.run");
  try {
    const respond = await request;
    await started.promise;
    expectProgress(respond, { running: true });
    expect(sweep).toHaveBeenCalledOnce();
    const running = maintenance.run().catch(() => {});
    completion.reject(new Error("second batch failed"));
    await running;
    expectProgress(await invoke("sessions.storage.status"), {
      running: false,
      ...progress,
      lastError: "second batch failed",
    });
  } finally {
    completion.resolve(progress);
  }
});

it.each(["sessions.storage.status", "sessions.storage.run"] as const)(
  "%s rejects expired request authority after inventory",
  async (method) => {
    let current = true;
    inventory.mockImplementation(async () => {
      current = false;
      return [];
    });
    const respond = await invoke(method, () => current);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("no longer authorized"),
      }),
    );
    expect(sweep).not.toHaveBeenCalled();
  },
);
