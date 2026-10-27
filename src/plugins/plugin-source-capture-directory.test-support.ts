import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { retainPluginSourceCaptureInstance } from "./plugin-source-capture-directory.js";

export async function sweepPluginSourceCapturesForTest(stateDir: string): Promise<void> {
  const scheduler = createTestGatewayScheduler();
  const instance = retainPluginSourceCaptureInstance(stateDir);
  try {
    await instance.startMaintenance(scheduler);
  } finally {
    try {
      await scheduler.stop();
    } finally {
      await instance.releaseAsync();
    }
  }
}
