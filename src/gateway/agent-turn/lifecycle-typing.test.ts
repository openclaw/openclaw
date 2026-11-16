import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ChannelHeartbeatAdapter } from "../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createLifecycleTypingManager } from "../lifecycle-typing.js";

let f: ReturnType<typeof fixture>;
beforeAll(async () => {
  // Resolve the real lazy dependency before fake timers can stall its initialization.
  await import("../../agents/agent-scope-config.js");
});
beforeEach(() => {
  // Keep module-loader and transport immediates real while advancing typing deadlines.
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  f = fixture();
});
afterEach(() => {
  f.manager.close();
  vi.useRealTimers();
});
type Options = Parameters<typeof createLifecycleTypingManager>[0];
type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
function fixture() {
  const defaults: Defaults = { timeoutSeconds: 120 };
  const state = { current: true, available: true };
  const started = createDeferredCore();
  const sendTyping = vi.fn(async () => started.resolve());
  const clearTyping = vi.fn(async () => {});
  const onError = vi.fn();
  const options: Options = {
    getConfig: () => ({ agents: { defaults } }),
    isAvailable: () => state.available,
    resolveAdapter: async () => ({ sendTypingGuarded: sendTyping, clearTyping }),
    onError,
  };
  const manager = createLifecycleTypingManager(options);
  const params = {
    channel: "telegram",
    to: "123",
    accountId: "work",
    threadId: 99,
    runId: "recovered-run",
    isCurrent: () => state.current,
  };
  return { manager, params, sendTyping, clearTyping, onError, state, defaults, options, started };
}
function typingConfig(typingMode?: "instant" | "never"): OpenClawConfig {
  return { agents: { defaults: { typingMode: "never" }, entries: { main: { typingMode } } } };
}
it("honors configured cadence beyond one minute and stops at settlement", async () => {
  f.defaults.typingIntervalSeconds = 10;
  const stop = f.manager.start(f.params);
  await f.started.promise;
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
    f.defaults.timeoutSeconds = state === "timed out" ? 1 : 120;
    f.manager.start(f.params);
    await vi.advanceTimersByTimeAsync(0);
    if (state === "retired") {
      f.state.current = false;
    } else if (state === "gateway unavailable") {
      f.state.available = false;
    } else if (state === "closed") {
      f.manager.close();
    }
    await vi.advanceTimersByTimeAsync(state === "timed out" ? 5_000 : 10_000);
    expect(f.sendTyping).toHaveBeenCalledOnce();
    expect(f.clearTyping).toHaveBeenCalledOnce();
  },
);
it.each(["retired", "legacy"])("rejects a %s adapter after lookup", async (reason) => {
  const adapter = createDeferredCore<ChannelHeartbeatAdapter>();
  const sendTyping = vi.fn(async () => {});
  f.options.resolveAdapter = () => adapter.promise;
  f.manager.start(f.params);
  if (reason === "retired") {
    f.state.current = false;
  }
  adapter.resolve(reason === "legacy" ? { sendTyping } : { sendTypingGuarded: sendTyping });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sendTyping).not.toHaveBeenCalled();
  if (reason === "legacy") {
    expect(f.onError).not.toHaveBeenCalled();
  }
});
it("shares one loop for duplicate starts of the same recovered run", async () => {
  const first = f.manager.start(f.params);
  expect(f.manager.start(f.params)).toBe(first);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sendTyping).toHaveBeenCalledOnce();
});
it("stops a failed typing request without throwing into final delivery", async () => {
  f.sendTyping.mockRejectedValueOnce(new Error("Typing unavailable"));
  expect(() => f.manager.start(f.params)).not.toThrow();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.sendTyping).toHaveBeenCalledOnce();
  expect(f.onError).toHaveBeenCalledOnce();
});
it.each([undefined, "instant"] as const)(
  "applies the %s override and live opt-out",
  async (initial) => {
    let mode: "instant" | "never" | undefined = initial;
    f.options.getConfig = () => typingConfig(mode);
    f.manager.start({ ...f.params, agentId: "main" });
    await vi.advanceTimersByTimeAsync(0);
    const calls = initial ? 1 : 0;
    expect(f.sendTyping).toHaveBeenCalledTimes(calls);
    mode = "never";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sendTyping).toHaveBeenCalledTimes(calls);
    expect(f.clearTyping).toHaveBeenCalledTimes(calls);
  },
);
