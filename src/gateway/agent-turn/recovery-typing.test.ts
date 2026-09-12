import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelHeartbeatAdapter } from "../../channels/plugins/types.adapters.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createRecoveryTypingManager } from "../recovery-typing.js";

const managers: ReturnType<typeof createRecoveryTypingManager>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.close();
  }
  vi.useRealTimers();
});
function fixture(
  options: {
    timeoutSeconds?: number;
    resolveAdapter?: () => Promise<ChannelHeartbeatAdapter | undefined>;
  } = {},
) {
  let current = true;
  let available = true;
  const sendTyping = vi.fn(async () => {});
  const clearTyping = vi.fn(async () => {});
  const onError = vi.fn();
  const manager = createRecoveryTypingManager({
    getConfig: () => ({ agents: { defaults: { timeoutSeconds: options.timeoutSeconds ?? 120 } } }),
    isAvailable: () => available,
    resolveAdapter:
      options.resolveAdapter ?? (async () => ({ sendTypingGuarded: sendTyping, clearTyping })),
    onError,
  });
  managers.push(manager);
  const params = {
    channel: "telegram",
    to: "123",
    accountId: "work",
    threadId: 99,
    runId: "recovered-run",
    isCurrent: () => current,
  };
  return {
    manager,
    params,
    sendTyping,
    clearTyping,
    onError,
    retire: () => {
      current = false;
    },
    closeGateway: () => {
      available = false;
    },
  };
}
describe("recovery typing", () => {
  it("keeps only typing active beyond one minute and stops at command settlement", async () => {
    const f = fixture();
    const stop = f.manager.start(f.params);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(f.sendTyping.mock.calls.length).toBeGreaterThan(20);
    expect(f.sendTyping).toHaveBeenCalledWith(
      expect.objectContaining({ to: "123", accountId: "work", threadId: 99 }),
    );
    const count = f.sendTyping.mock.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sendTyping).toHaveBeenCalledTimes(count);
    expect(f.clearTyping).toHaveBeenCalledOnce();
  });
  it.each(["retired", "gateway unavailable", "closed"])("stops when %s", async (state) => {
    const f = fixture();
    f.manager.start(f.params);
    await vi.advanceTimersByTimeAsync(0);
    if (state === "retired") {
      f.retire();
    } else if (state === "gateway unavailable") {
      f.closeGateway();
    } else {
      f.manager.close();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sendTyping).toHaveBeenCalledOnce();
    expect(f.clearTyping).toHaveBeenCalledOnce();
  });
  it("does not start after a delayed adapter lookup loses its owner", async () => {
    const adapter = createDeferredCore<ChannelHeartbeatAdapter>();
    const sendTyping = vi.fn(async () => {});
    const f = fixture({ resolveAdapter: () => adapter.promise });
    f.manager.start(f.params);
    f.retire();
    adapter.resolve({ sendTypingGuarded: sendTyping });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendTyping).not.toHaveBeenCalled();
  });
  it("shares one loop for duplicate starts of the same recovered run", async () => {
    const f = fixture();
    const first = f.manager.start(f.params);
    expect(f.manager.start(f.params)).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sendTyping).toHaveBeenCalledOnce();
  });
  it("retains the configured agent timeout as a safety bound", async () => {
    const f = fixture({ timeoutSeconds: 1 });
    f.manager.start(f.params);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.sendTyping).toHaveBeenCalledOnce();
    expect(f.clearTyping).toHaveBeenCalledOnce();
  });
  it("stops a failed typing request without throwing into final delivery", async () => {
    const f = fixture();
    f.sendTyping.mockRejectedValueOnce(new Error("Typing unavailable"));
    expect(() => f.manager.start(f.params)).not.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sendTyping).toHaveBeenCalledOnce();
    expect(f.onError).toHaveBeenCalledOnce();
  });
  it("does nothing for a channel without typing support", async () => {
    const f = fixture({ resolveAdapter: async () => undefined });
    f.manager.start(f.params);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sendTyping).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });
  it.each(["default", "agent"] as const)("respects a %s typing opt-out", async (where) => {
    const sendTyping = vi.fn(async () => {});
    const manager = createRecoveryTypingManager({
      isAvailable: () => true,
      getConfig: () => ({
        agents: {
          defaults: { typingMode: where === "default" ? "never" : "instant" },
          entries: { main: { typingMode: where === "agent" ? "never" : undefined } },
        },
      }),
      resolveAdapter: async () => ({ sendTypingGuarded: sendTyping }),
    });
    managers.push(manager);
    manager.start({
      agentId: "main",
      channel: "telegram",
      to: "123",
      runId: "optout",
      isCurrent: () => true,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendTyping).not.toHaveBeenCalled();
  });
  it("honors an agent override and a later opt-out without using stale config", async () => {
    let enabled = true;
    const sendTyping = vi.fn(async () => {});
    const clearTyping = vi.fn(async () => {});
    const manager = createRecoveryTypingManager({
      isAvailable: () => true,
      getConfig: () => ({
        agents: {
          defaults: { typingMode: "never" },
          entries: { main: { typingMode: enabled ? "instant" : "never" } },
        },
      }),
      resolveAdapter: async () => ({ sendTypingGuarded: sendTyping, clearTyping }),
    });
    managers.push(manager);
    manager.start({
      agentId: "main",
      channel: "telegram",
      to: "123",
      runId: "override",
      isCurrent: () => true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTyping).toHaveBeenCalledOnce();
    enabled = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendTyping).toHaveBeenCalledOnce();
    expect(clearTyping).toHaveBeenCalledOnce();
  });
  it("does not fall back to an unguarded legacy typing hook", async () => {
    const legacy = vi.fn(async () => {});
    const f = fixture({ resolveAdapter: async () => ({ sendTyping: legacy }) });
    f.manager.start(f.params);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(legacy).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });
});
