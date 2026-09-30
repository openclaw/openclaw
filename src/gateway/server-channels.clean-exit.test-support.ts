import { expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.public.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { channelReadyPatch } from "./channel-status-patches.js";
import type { ChannelManager } from "./server-channels.js";
import { createTestPlugin, type TestAccount } from "./server-channels.test-support.js";

// Register these cases in the lifecycle owner's suite to share its mocks and cleanup.
export function registerChannelCleanExitTests({
  installTestRegistry,
  createManager,
  flushMicrotasks,
  advanceTimersUntil,
  waitForAbort,
}: {
  installTestRegistry: (plugin: ChannelPlugin<TestAccount>) => unknown;
  createManager: () => ChannelManager;
  flushMicrotasks: () => Promise<void>;
  advanceTimersUntil: (
    check: () => boolean,
    message: string,
    options: { stepMs: number; maxMs: number },
  ) => Promise<void>;
  waitForAbort: (signal: AbortSignal) => Promise<void>;
}): void {
  it("preserves a nonterminal exit diagnosis until the replacement lifecycle starts", async () => {
    const error = "getaddrinfo EAI_AGAIN";
    const lastDisconnect = { at: Date.now(), status: 408, error, loggedOut: false };
    const handoffStates: ChannelAccountSnapshot[] = [];
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      handoffStates.push({ ...ctx.getStatus() });
      if (handoffStates.length === 1) {
        ctx.setStatus({
          accountId: ctx.accountId,
          running: false,
          connected: false,
          lifecycle: "stopped",
          terminalDisconnect: false,
          lastError: error,
          lastDisconnect,
        });
        return;
      }
      ctx.setStatus(channelReadyPatch({ accountId: ctx.accountId }));
      await waitForAbort(ctx.abortSignal);
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();
    const readAccount = () =>
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];

    await manager.startChannels();
    await flushMicrotasks();

    expect(manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
    expect(readAccount()).toMatchObject({
      running: false,
      connected: false,
      restartPending: true,
      lifecycle: "recovering",
      terminalDisconnect: false,
      lastError: error,
      lastDisconnect,
    });

    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    expect(handoffStates).toHaveLength(2);
    expect(handoffStates[1]).toMatchObject({
      lifecycle: "starting",
      lastError: null,
      lastDisconnect,
    });
    expect(readAccount()).toMatchObject({
      running: true,
      connected: true,
      restartPending: false,
      lifecycle: "ready",
      terminalDisconnect: undefined,
      lastError: null,
      lastDisconnect,
    });
  });

  it("caps crash-loop restarts after max attempts", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    await advanceTimersUntil(
      () => startAccount.mock.calls.length >= 11,
      "expected crash-loop restarts to reach the maximum attempt cap",
      { stepMs: 10, maxMs: 500 },
    );

    expect(startAccount).toHaveBeenCalledTimes(11);
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(false);
    expect(account?.reconnectAttempts).toBe(11);
    expect(account?.lastError).toBe("channel exited without an error");

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(11);
  });

  it("claims auto-restart ownership between crash-loop attempts", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await flushMicrotasks();

    // The health monitor must see the supervisor own recovery here, otherwise it
    // resets the attempt ladder and the give-up below never happens.
    expect(manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
    expect(
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID],
    ).toMatchObject({
      running: false,
      restartPending: true,
      lifecycle: "recovering",
      lastError: "channel exited without an error",
    });

    // A competing restart request cannot help while the supervisor holds the
    // account task; it returns without booting anything.
    const startsBeforeRequest = startAccount.mock.calls.length;
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(startAccount).toHaveBeenCalledTimes(startsBeforeRequest);

    await advanceTimersUntil(
      () => startAccount.mock.calls.length >= 11,
      "expected crash-loop restarts to reach the maximum attempt cap",
      { stepMs: 10, maxMs: 500 },
    );

    expect(manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
  });
}
