import { expect, it, vi } from "vitest";
import { currentUpdateCheckLifecycle } from "../infra/update-check-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDeferredGatewayUpdateCheck } from "./server-startup-update-check.js";

const command = vi.hoisted(() => vi.fn());
// Observe the process boundary; keep update policy, discovery, and lifecycle real.
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: command,
}));

it.each([false, true])(
  "defers install probes until requested with checkOnStart=%s",
  async (checkOnStart) => {
    const state = await createOpenClawTestState({ label: "startup-install-discovery" });
    const scheduler = createTestGatewayScheduler();
    await import("../infra/update-startup.js");
    command.mockReset().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "synthetic unavailable command",
      signal: null,
      killed: false,
      termination: "exit",
    });
    const owner = createDeferredGatewayUpdateCheck({
      scheduler,
      getConfig: () => ({ update: { checkOnStart } }),
      getPluginRegistry: () => undefined,
      log: { info: vi.fn(), warn: vi.fn() },
      isNixMode: false,
      broadcastToConnIds: vi.fn(),
      getClientConnIds: () => new Set(),
    });
    try {
      const initialize = vi.spyOn(currentUpdateCheckLifecycle(), "initialize");
      owner.start();
      await vi.waitFor(() => expect(scheduler.nextWakeAtMs).not.toBeNull());
      await Promise.all(initialize.mock.results.map((result) => result.value));
      expect(command).not.toHaveBeenCalled();
      await currentUpdateCheckLifecycle().initialize();
      expect(command).toHaveBeenCalled();
    } finally {
      await owner.stop();
      await scheduler.stop();
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  },
);
