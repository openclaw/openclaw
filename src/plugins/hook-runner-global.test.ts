import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

async function importHookRunnerGlobalModule() {
  return import("./hook-runner-global.js");
}

async function expectGlobalRunnerState(expected: { hasRunner: boolean; registry?: unknown }) {
  const mod = await importHookRunnerGlobalModule();
  expect(mod.getGlobalHookRunner() === null).toBe(!expected.hasRunner);
  if ("registry" in expected) {
    expect(mod.getGlobalPluginRegistry()).toBe(expected.registry ?? null);
  }
  return mod;
}

afterEach(async () => {
  const mod = await importHookRunnerGlobalModule();
  mod.resetGlobalHookRunner();
});

describe("hook-runner-global", () => {
  async function createInitializedModule() {
    const modA = await importHookRunnerGlobalModule();
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler: vi.fn() }]);
    modA.initializeGlobalHookRunner(registry);
    return { modA, registry };
  }

  it("preserves the initialized runner across module reloads", async () => {
    const { modA, registry } = await createInitializedModule();
    expect(modA.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);

    vi.resetModules();

    const modB = await expectGlobalRunnerState({ hasRunner: true, registry });
    expect(modB.getGlobalHookRunner()).not.toBeNull();
    expect(modB.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);
  });

  it("clears the shared state across module reloads", async () => {
    await createInitializedModule();

    vi.resetModules();

    const modB = await expectGlobalRunnerState({ hasRunner: true });
    modB.resetGlobalHookRunner();
    expect(modB.getGlobalHookRunner()).toBeNull();
    expect(modB.getGlobalPluginRegistry()).toBeNull();

    vi.resetModules();

    await expectGlobalRunnerState({ hasRunner: false });
  });

  it("carries forward hooks from the previous registry when the new one lacks them", async () => {
    const mod = await importHookRunnerGlobalModule();
    const handler = vi.fn();
    const oldRegistry = createMockPluginRegistry([{ hookName: "message_received", handler }]);
    mod.initializeGlobalHookRunner(oldRegistry);
    expect(mod.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);

    // Simulate a late plugin reload that produces a registry without the hook.
    const newRegistry = createMockPluginRegistry([]);
    // Give the new registry a different plugin id so it's clearly distinct.
    newRegistry.plugins = [{ ...newRegistry.plugins[0], id: "other-plugin" }];
    newRegistry.typedHooks = [];
    mod.initializeGlobalHookRunner(newRegistry);

    // The message_received hook from the old registry must survive.
    expect(mod.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);
  });

  it("does not duplicate hooks when the new registry already contains the same plugin", async () => {
    const mod = await importHookRunnerGlobalModule();
    const handler = vi.fn();
    const registry1 = createMockPluginRegistry([{ hookName: "message_received", handler }]);
    mod.initializeGlobalHookRunner(registry1);

    // Re-initialize with a registry that has the same plugin id's hooks.
    const registry2 = createMockPluginRegistry([{ hookName: "message_received", handler }]);
    mod.initializeGlobalHookRunner(registry2);

    expect(mod.getGlobalHookRunner()?.getHookCount("message_received")).toBe(1);
  });
});
