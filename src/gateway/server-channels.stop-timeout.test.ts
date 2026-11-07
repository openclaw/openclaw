import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  clearActiveCredentialDegradedOwners,
  setActiveDegradedSecretOwners,
} from "../secrets/runtime-degraded-state.js";
import type { ChannelManager } from "./server-channels.js";
import {
  createTestChannelManager,
  createTestPlugin,
  installTestRegistry,
  type TestAccount,
  waitForAbort,
} from "./server-channels.test-support.js";

const hoisted = vi.hoisted(() => ({ sleepWithAbort: vi.fn() }));
vi.mock("../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/backoff.js")>()),
  sleepWithAbort: hoisted.sleepWithAbort,
}));
vi.mock("../infra/approval-handler-bootstrap.js", () => ({
  startChannelApprovalHandlerBootstrap: vi.fn(async () => async () => {}),
}));

describe("server-channels manual stop timeout recovery", () => {
  let previousRegistry: PluginRegistry | null = null;
  let manager: ChannelManager | undefined;

  beforeEach(() => {
    resetGatewayWorkAdmission();
    previousRegistry = getActivePluginRegistry();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    hoisted.sleepWithAbort.mockClear();
    clearActiveCredentialDegradedOwners();
    setActiveDegradedSecretOwners([]);
  });

  afterEach(async () => {
    const stop = manager?.stopChannel("discord");
    await vi.advanceTimersByTimeAsync(6_000);
    await stop;
    manager = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    resetGatewayWorkAdmission();
    clearActiveCredentialDegradedOwners();
    setActiveDegradedSecretOwners([]);
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("recovers a manual stop timeout through the existing staged start handoff", async () => {
    const releaseFirstTask = createDeferred();
    const contexts: ChannelGatewayContext<TestAccount>[] = [];
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      contexts.push(ctx);
      if (contexts.length === 1) {
        await releaseFirstTask.promise;
        throw new Error("late abandoned task failure");
      }
      await waitForAbort(ctx.abortSignal);
    });
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    manager = createTestChannelManager();

    await manager.startChannels();
    const stopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopTask;
    expect(contexts[0]?.abortSignal.aborted).toBe(true);
    expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
    expect(
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID],
    ).toMatchObject({
      running: true,
      restartPending: false,
      lastError: "channel stop timed out after 5000ms",
    });

    // Automatic recovery must not override the operator's stop.
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { preserveManualStop: true });
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(true);

    // Preserve this maintenance line's two-stage recovery admission contract.
    const pending = await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(pending.get(DEFAULT_ACCOUNT_ID)).toEqual({ status: "retry", reason: "task-owned" });
    expect(startAccount).toHaveBeenCalledTimes(1);
    const recovered = await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(recovered.get(DEFAULT_ACCOUNT_ID)).toEqual({ status: "handed-off" });
    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
    expect(contexts[1]?.abortSignal.aborted).toBe(false);

    contexts[0]?.setStatus({ accountId: DEFAULT_ACCOUNT_ID, lastError: "stale status" });
    releaseFirstTask.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID],
    ).toMatchObject({
      running: true,
      restartPending: false,
      lastError: null,
    });
    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();

    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(contexts[1]?.abortSignal.aborted).toBe(true);
    expect(
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID],
    ).toMatchObject({
      running: false,
      restartPending: false,
    });
  });
});
