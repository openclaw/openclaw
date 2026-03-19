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

  it("does not replace an existing runner that has typed hooks", async () => {
    const mod = await importHookRunnerGlobalModule();
    const registryWithHooks = createMockPluginRegistry([
      { hookName: "llm_input", handler: vi.fn() },
    ]);
    const emptyRegistry = createMockPluginRegistry([]);

    mod.initializeGlobalHookRunner(registryWithHooks);
    const originalRunner = mod.getGlobalHookRunner();
    expect(originalRunner?.hasHooks("llm_input")).toBe(true);

    // Second call with empty registry should be a no-op
    mod.initializeGlobalHookRunner(emptyRegistry);
    expect(mod.getGlobalHookRunner()).toBe(originalRunner);
    expect(mod.getGlobalPluginRegistry()).toBe(registryWithHooks);
    expect(mod.getGlobalHookRunner()?.hasHooks("llm_input")).toBe(true);
  });

  it("allows replacing a runner that has no typed hooks", async () => {
    const mod = await importHookRunnerGlobalModule();
    const emptyRegistry = createMockPluginRegistry([]);
    const registryWithHooks = createMockPluginRegistry([
      { hookName: "llm_input", handler: vi.fn() },
    ]);

    mod.initializeGlobalHookRunner(emptyRegistry);
    expect(mod.getGlobalHookRunner()?.hasHooks("llm_input")).toBe(false);

    // Second call with hooks should replace
    mod.initializeGlobalHookRunner(registryWithHooks);
    expect(mod.getGlobalHookRunner()?.hasHooks("llm_input")).toBe(true);
    expect(mod.getGlobalPluginRegistry()).toBe(registryWithHooks);
  });

  it("allows re-initialization after reset", async () => {
    const mod = await importHookRunnerGlobalModule();
    const registryA = createMockPluginRegistry([{ hookName: "llm_input", handler: vi.fn() }]);
    const registryB = createMockPluginRegistry([{ hookName: "llm_output", handler: vi.fn() }]);

    mod.initializeGlobalHookRunner(registryA);
    expect(mod.getGlobalHookRunner()?.hasHooks("llm_input")).toBe(true);

    mod.resetGlobalHookRunner();
    expect(mod.getGlobalHookRunner()).toBeNull();

    mod.initializeGlobalHookRunner(registryB);
    expect(mod.getGlobalHookRunner()?.hasHooks("llm_output")).toBe(true);
    expect(mod.getGlobalHookRunner()?.hasHooks("llm_input")).toBe(false);
  });
});
