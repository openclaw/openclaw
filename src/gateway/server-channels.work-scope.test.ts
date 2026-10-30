import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  captureThawRestartTargets,
  restartRunningChannelAccounts,
} from "./channel-thaw-restart.js";
import {
  createTestChannelManager,
  createTestChannelRegistry,
  createTestPlugin,
  waitForAbort,
} from "./server-channels.test-support.js";

vi.mock("../infra/approval-handler-bootstrap.js", () => ({
  startChannelApprovalHandlerBootstrap: async () => async () => {},
}));

afterEach(resetGatewayWorkAdmission);

it("keeps thaw-restarted channel work alive after the maintenance tick finishes", async () => {
  resetGatewayWorkAdmission();
  const inbound = createDeferred();
  const reply = createDeferred<string>();
  const started = [createDeferred<AbortSignal>(), createDeferred<AbortSignal>()] as const;
  let starts = 0;
  const plugin = createTestPlugin({
    startAccount: async ({ abortSignal }) => {
      started[starts++ === 0 ? 0 : 1].resolve(abortSignal);
      if (starts > 1) {
        await inbound.promise;
        reply.resolve(trackAsyncWork(async () => "reply"));
      }
      await waitForAbort(abortSignal);
    },
  });
  const registry = createTestChannelRegistry(plugin);
  const manager = createTestChannelManager({ getPluginRegistry: () => registry });
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const errors: string[] = [];
  let maintenanceSignal: AbortSignal | undefined;
  try {
    await manager.startChannels();
    const originalSignal = await started[0].promise;
    scheduler.schedule({
      id: "maintenance:host-thaw",
      delayMs: 0,
      run: async () => {
        maintenanceSignal = getAsyncWorkSignal();
        await restartRunningChannelAccounts(captureThawRestartTargets(manager), {
          shouldContinue: () => true,
          onError: (message) => errors.push(message),
        });
      },
    });
    await clock.wake();
    expect(errors).toEqual([]);
    const replacementSignal = await started[1].promise;
    const signals = [maintenanceSignal, originalSignal, replacementSignal];
    expect(signals.map((signal) => signal?.aborted)).toEqual([true, true, false]);
    inbound.resolve();
    await expect(reply.promise).resolves.toBe("reply");
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.default?.running).toBe(true);
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(replacementSignal.aborted).toBe(true);
  } finally {
    inbound.resolve();
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await scheduler.stop();
  }
});
