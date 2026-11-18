import { afterEach, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayUpdateLifecycle } from "./update-check-lifecycle.js";

const { refreshRemoteModelCatalogMock: refreshCatalog } = await vi.hoisted(
  () => import("./update-startup.test-support.js"),
);
const { createGatewayUpdateCheck, runGatewayUpdateCheck } = await import("./update-startup.js");
afterEach(() => vi.restoreAllMocks());

it("defers low-memory scheduled update and catalog work, but not explicit checks", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "update-memory-",
    env: { NODE_ENV: undefined, VITEST: undefined },
  });
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const lifecycle = createGatewayUpdateLifecycle(scheduler);
  vi.spyOn(process, "constrainedMemory").mockReturnValue(1_000);
  const available = vi.spyOn(process, "availableMemory").mockReturnValue(100);
  const getConfig = vi.fn(() => ({ update: { checkOnStart: false } }));
  refreshCatalog.mockReset().mockResolvedValue({ status: "disabled", providers: 0, models: 0 });
  const params = {
    lifecycle,
    getConfig,
    isNixMode: false,
    log: { info: vi.fn() },
    applyRemoteCatalogUpdate: vi.fn(async () => "unchanged" as const),
  };
  const check = createGatewayUpdateCheck(params);
  try {
    check.start();
    await clock.advanceBy(0);
    expect(getConfig).not.toHaveBeenCalled();
    expect(refreshCatalog).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBe(60_000);
    await runGatewayUpdateCheck(params, lifecycle);
    expect(getConfig).toHaveBeenCalled();
    getConfig.mockClear();
    available.mockReturnValue(500);
    await clock.advanceBy(60_000);
    expect(getConfig).toHaveBeenCalled();
    expect(refreshCatalog).toHaveBeenCalledOnce();
    await check.stop();
    await clock.advanceBy(60_000);
    expect(refreshCatalog).toHaveBeenCalledOnce();
  } finally {
    await check.stop();
    await scheduler.stop();
    await state.cleanup();
  }
});
