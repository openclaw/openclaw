import { onTestFinished } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { LegacyPluginSdkResourceHost } from "./legacy-sdk-resource-host.js";
import { startOneShotDiagnosticsExporters } from "./one-shot-diagnostics.js";

export function createOneShotDiagnosticsTestHost() {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const host = new LegacyPluginSdkResourceHost();
  host.bindScheduler(scheduler);
  onTestFinished(async () => {
    await scheduler.stop();
    await host.close();
  });
  return {
    clock,
    scheduler,
    start: (params: Parameters<typeof startOneShotDiagnosticsExporters>[0]) =>
      host.run(() => startOneShotDiagnosticsExporters(params)),
  };
}
