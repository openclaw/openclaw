import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelHeartbeatAdapter } from "../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createRecoveryTypingManager } from "../recovery-typing.js";

const managers: ReturnType<typeof createRecoveryTypingManager>[] = [];
beforeAll(async () => {
  // Resolve the real lazy dependency before fake timers can stall its initialization.
  await import("../../agents/agent-scope-config.js");
});
beforeEach(() => {
  // Keep module-loader and transport immediates real while advancing typing deadlines.
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
});
afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.close();
  }
  vi.useRealTimers();
});
type Options = Parameters<typeof createRecoveryTypingManager>[0];
type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
function fixture(
  options: Partial<Pick<Options, "getConfig" | "resolveAdapter">> = {},
  defaults: Defaults = { timeoutSeconds: 120 },
) {
  const state = { current: true, available: true };
  const sendTyping = vi.fn(async () => {});
  const clearTyping = vi.fn(async () => {});
  const onError = vi.fn();
  const manager = createRecoveryTypingManager({
    getConfig: options.getConfig ?? (() => ({ agents: { defaults } })),
    isAvailable: () => state.available,
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
    isCurrent: () => state.current,
  };
  return { manager, params, sendTyping, clearTyping, onError, state };
}
async function start(f: ReturnType<typeof fixture>, ms = 10_000) {
  f.manager.start(f.params);
  await vi.advanceTimersByTimeAsync(ms);
}
function expectStopped(f: ReturnType<typeof fixture>) {
  expect(f.sendTyping).toHaveBeenCalledOnce();
  expect(f.clearTyping).toHaveBeenCalledOnce();
}
function typingConfig(typingMode?: "instant" | "never"): OpenClawConfig {
  return { agents: { defaults: { typingMode: "never" }, entries: { main: { typingMode } } } };
}
describe("recovery typing", () => {
  it("honors configured cadence beyond one minute and stops at settlement", async () => {
    const f = fixture({}, { timeoutSeconds: 120, typingIntervalSeconds: 10 });
    const firstTyping = createDeferredCore();
    f.sendTyping.mockImplementationOnce(async () => {
      firstTyping.resolve();
    });
    const stop = f.manager.start(f.params);
    await firstTyping.promise;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(f.sendTyping).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(55_001);
    expect(f.sendTyping).toHaveBeenCalledTimes(7);
    expect(f.sendTyping).toHaveBeenCalledWith(
      expect.objectContaining({ to: "123", accountId: "work", threadId: 99 }),
    );
    const count = f.sendTyping.mock.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sendTyping).toHaveBeenCalledTimes(count);
    expect(f.clearTyping).toHaveBeenCalledOnce();
  });
  it.each(["retired", "gateway unavailable", "closed", "timed out"])(
    "stops when %s",
    async (state) => {
      const f = fixture({}, { timeoutSeconds: state === "timed out" ? 1 : 120 });
      await start(f, 0);
      if (state === "retired") {
        f.state.current = false;
      } else if (state === "gateway unavailable") {
        f.state.available = false;
      } else if (state === "closed") {
        f.manager.close();
      }
      await vi.advanceTimersByTimeAsync(state === "timed out" ? 5_000 : 10_000);
      expectStopped(f);
    },
  );
  it("does not start after a delayed adapter lookup loses its owner", async () => {
    const adapter = createDeferredCore<ChannelHeartbeatAdapter>();
    const sendTyping = vi.fn(async () => {});
    const f = fixture({ resolveAdapter: () => adapter.promise });
    f.manager.start(f.params);
    f.state.current = false;
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
  it("stops a failed typing request without throwing into final delivery", async () => {
    const f = fixture();
    f.sendTyping.mockRejectedValueOnce(new Error("Typing unavailable"));
    expect(() => f.manager.start(f.params)).not.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sendTyping).toHaveBeenCalledOnce();
    expect(f.onError).toHaveBeenCalledOnce();
  });
  it("respects a default typing opt-out", async () => {
    const f = fixture({ getConfig: () => typingConfig() });
    f.manager.start({ ...f.params, agentId: "main" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sendTyping).not.toHaveBeenCalled();
  });
  it("honors an agent override and a later opt-out without using stale config", async () => {
    let enabled = true;
    const f = fixture({
      getConfig: () => typingConfig(enabled ? "instant" : "never"),
    });
    f.manager.start({ ...f.params, agentId: "main" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sendTyping).toHaveBeenCalledOnce();
    enabled = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expectStopped(f);
  });
  it("does not fall back to an unguarded legacy typing hook", async () => {
    const legacy = vi.fn(async () => {});
    const f = fixture({ resolveAdapter: async () => ({ sendTyping: legacy }) });
    await start(f);
    expect(legacy).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });
});
