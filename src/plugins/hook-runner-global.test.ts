import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

async function importHookRunnerGlobalModule() {
  return import("./hook-runner-global.js");
}

afterEach(async () => {
  const mod = await importHookRunnerGlobalModule();
  mod.resetGlobalHookRunner();
  vi.resetModules();
});

describe("hook-runner-global", () => {
  it("preserves the initialized runner across module reloads", async () => {
    const modA = await importHookRunnerGlobalModule();
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler: vi.fn() }]);

    modA.initializeGlobalHookRunner(registry);
    expect(modA.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);

    vi.resetModules();

    const modB = await importHookRunnerGlobalModule();
    expect(modB.getGlobalHookRunner()).not.toBeNull();
    expect(modB.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);
    expect(modB.getGlobalPluginRegistry()).toBe(registry);
  });

  it("clears the shared state across module reloads", async () => {
    const modA = await importHookRunnerGlobalModule();
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler: vi.fn() }]);

    modA.initializeGlobalHookRunner(registry);

    vi.resetModules();

    const modB = await importHookRunnerGlobalModule();
    modB.resetGlobalHookRunner();
    expect(modB.getGlobalHookRunner()).toBeNull();
    expect(modB.getGlobalPluginRegistry()).toBeNull();

    vi.resetModules();

    const modC = await importHookRunnerGlobalModule();
    expect(modC.getGlobalHookRunner()).toBeNull();
    expect(modC.getGlobalPluginRegistry()).toBeNull();
  });

  describe("reinitialization race condition (#42644)", () => {
    it("defers reinitialization while a hook execution is in-flight", async () => {
      const mod = await importHookRunnerGlobalModule();

      let resolveHook!: () => void;
      const hookPromise = new Promise<void>((resolve) => {
        resolveHook = resolve;
      });
      const handler = vi.fn(() => hookPromise);

      const registryA = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
      mod.initializeGlobalHookRunner(registryA);

      const runnerA = mod.getGlobalHookRunner();
      expect(runnerA?.hasHooks("message_sending")).toBe(true);

      // Start an in-flight hook execution
      const executionPromise = mod.withGlobalHookExecution(() =>
        runnerA!.runMessageSending(
          { to: "user", content: "hello", metadata: { channel: "test" } } as never,
          { channelId: "test" } as never,
        ),
      );

      // While the hook is in-flight, reinitialize with a new registry
      const registryB = createMockPluginRegistry([
        { hookName: "message_received", handler: vi.fn() },
      ]);
      mod.initializeGlobalHookRunner(registryB);

      // The old runner should still be active (reinitialization deferred)
      expect(mod.getGlobalHookRunner()).toBe(runnerA);
      expect(mod.getGlobalPluginRegistry()).toBe(registryA);

      // Complete the in-flight hook
      resolveHook();
      await executionPromise;

      // Now the deferred reinitialization should have been applied
      expect(mod.getGlobalPluginRegistry()).toBe(registryB);
      expect(mod.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);
      expect(mod.getGlobalHookRunner()?.hasHooks("message_sending")).toBe(false);
    });

    it("applies the latest pending registry when multiple reinits are deferred", async () => {
      const mod = await importHookRunnerGlobalModule();

      let resolveHook!: () => void;
      const hookPromise = new Promise<void>((resolve) => {
        resolveHook = resolve;
      });
      const handler = vi.fn(() => hookPromise);

      const registryA = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
      mod.initializeGlobalHookRunner(registryA);

      const runnerA = mod.getGlobalHookRunner();

      // Start in-flight execution
      const executionPromise = mod.withGlobalHookExecution(() =>
        runnerA!.runMessageSending(
          { to: "user", content: "hello", metadata: { channel: "test" } } as never,
          { channelId: "test" } as never,
        ),
      );

      // Queue two reinitializations — only the last should take effect
      const registryB = createMockPluginRegistry([
        { hookName: "message_received", handler: vi.fn() },
      ]);
      const registryC = createMockPluginRegistry([{ hookName: "session_start", handler: vi.fn() }]);
      mod.initializeGlobalHookRunner(registryB);
      mod.initializeGlobalHookRunner(registryC);

      // Still the old runner
      expect(mod.getGlobalPluginRegistry()).toBe(registryA);

      resolveHook();
      await executionPromise;

      // Only registryC (the latest) should be active
      expect(mod.getGlobalPluginRegistry()).toBe(registryC);
      expect(mod.getGlobalHookRunner()?.hasHooks("session_start")).toBe(true);
      expect(mod.getGlobalHookRunner()?.hasHooks("message_received")).toBe(false);
    });

    it("swaps immediately when no hooks are in-flight", async () => {
      const mod = await importHookRunnerGlobalModule();

      const registryA = createMockPluginRegistry([
        { hookName: "message_sending", handler: vi.fn() },
      ]);
      mod.initializeGlobalHookRunner(registryA);

      const registryB = createMockPluginRegistry([
        { hookName: "message_received", handler: vi.fn() },
      ]);
      mod.initializeGlobalHookRunner(registryB);

      // Immediate swap — no in-flight hooks
      expect(mod.getGlobalPluginRegistry()).toBe(registryB);
      expect(mod.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);
    });

    it("keeps old runner active if hook errors during guarded execution", async () => {
      const mod = await importHookRunnerGlobalModule();

      const handler = vi.fn(() => Promise.reject(new Error("hook failed")));
      const registryA = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
      mod.initializeGlobalHookRunner(registryA);

      const registryB = createMockPluginRegistry([
        { hookName: "message_received", handler: vi.fn() },
      ]);

      // Even if the hook throws, the deferred init should still fire
      await expect(
        mod.withGlobalHookExecution(async () => {
          mod.initializeGlobalHookRunner(registryB);
          // Old runner is still active during execution
          expect(mod.getGlobalPluginRegistry()).toBe(registryA);
          throw new Error("hook failed");
        }),
      ).rejects.toThrow("hook failed");

      // Pending init should have been flushed in the finally block
      expect(mod.getGlobalPluginRegistry()).toBe(registryB);
    });
  });
});
