import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createMaintenanceHandles } from "./server-runtime-services.test-harness.js";

const { clearGatewayMaintenanceHandles } = await import("./server-runtime-services.js");

afterEach(() => {
  vi.useRealTimers();
});

it("joins telemetry admitted before post-ready maintenance cleanup", async () => {
  vi.useFakeTimers();
  const maintenance = createMaintenanceHandles();
  const stopped = createDeferredCore();
  maintenance.stopTelemetryChecks.mockImplementation(() => stopped.promise);
  let cleared = false;
  const clearing = clearGatewayMaintenanceHandles(maintenance).then(() => {
    cleared = true;
  });
  try {
    expect(maintenance.stopTelemetryChecks).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(cleared).toBe(false);
  } finally {
    stopped.resolve();
    await clearing;
  }
  expect(cleared).toBe(true);
});
