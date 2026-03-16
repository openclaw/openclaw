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
});
