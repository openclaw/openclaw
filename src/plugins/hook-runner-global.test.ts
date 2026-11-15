/** Verifies global hook runner sequencing, mutation, and error behavior. */
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";

async function importHookRunnerGlobalModule() {
  return import("./hook-runner-global.js");
}

type HookRunnerGlobalModule = Awaited<ReturnType<typeof importHookRunnerGlobalModule>>;
type HookRunner = NonNullable<ReturnType<HookRunnerGlobalModule["getGlobalHookRunner"]>>;

function expectGlobalHookRunner(
  runner: ReturnType<HookRunnerGlobalModule["getGlobalHookRunner"]>,
): HookRunner {
  if (runner === null) {
    throw new Error("Expected global hook runner");
  }
  expect(typeof runner.hasHooks).toBe("function");
  return runner;
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
  vi.useRealTimers();
  const mod = await importHookRunnerGlobalModule();
  mod.resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("hook-runner-global", () => {
  async function createInitializedModule() {
    resetPluginRuntimeStateForTest();
    const modA = await importHookRunnerGlobalModule();
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler: vi.fn() }]);
    modA.initializeGlobalHookRunner(registry);
    return { modA, registry };
  }

  it("clears the shared state across module reloads", async () => {
    const { registry } = await createInitializedModule();

    vi.resetModules();

    const modB = await expectGlobalRunnerState({ hasRunner: true, registry });
    expect(expectGlobalHookRunner(modB.getGlobalHookRunner()).hasHooks("message_received")).toBe(
      true,
    );
    modB.resetGlobalHookRunner();
    expect(modB.getGlobalHookRunner()).toBeNull();
    expect(modB.getGlobalPluginRegistry()).toBeNull();

    vi.resetModules();

    await expectGlobalRunnerState({ hasRunner: false });
  });

  it("checks scoped reply dispatch with only the host dispatch kind", async () => {
    const registry = createMockPluginRegistry([]);
    registry.typedHooks.push({
      pluginId: "acp-dispatch",
      hookName: "reply_dispatch",
      handler: vi.fn(),
      eligibleDispatchKinds: ["acp"],
      source: "test",
    });
    const mod = await importHookRunnerGlobalModule();
    setActivePluginRegistry(registry);
    mod.initializeGlobalHookRunner(registry);

    expect(mod.hasGlobalHooks("reply_dispatch", { dispatchKind: "agent" })).toBe(false);
    expect(mod.hasGlobalHooks("reply_dispatch", { dispatchKind: "acp" })).toBe(true);
    expect(mod.hasGlobalHooks("reply_dispatch", {})).toBe(true);
    expect(mod.hasGlobalHooks("reply_dispatch")).toBe(true);
  });

  it.each([
    {
      hookName: "before_tool_call" as const,
      run: (runner: HookRunner) =>
        runner.runBeforeToolCall({ toolName: "read", params: {} }, { toolName: "read" }),
    },
    {
      hookName: "before_reset" as const,
      run: (runner: HookRunner) =>
        runner.runBeforeReset({ reason: "new" } as never, { sessionKey: "main" } as never),
    },
  ])(
    "waits out a plugin replacement before dispatching $hookName to the published registration",
    async ({ hookName, run }) => {
      // Earlier cases reset modules; use the instance class from the runner's module graph.
      const { PluginInstance } = await import("./plugin-instance.js");
      const previous = new PluginInstance("swap-policy");
      const current = new PluginInstance("swap-policy");
      const previousHandler = vi.fn();
      const currentHandler = vi.fn();
      const previousRegistry = createMockPluginRegistry([
        { hookName, pluginId: "swap-policy", handler: previous.wrap(previousHandler) },
      ]);
      const currentRegistry = createMockPluginRegistry([
        { hookName, pluginId: "swap-policy", handler: current.wrap(currentHandler) },
      ]);
      const mod = await importHookRunnerGlobalModule();
      setActivePluginRegistry(previousRegistry);
      mod.initializeGlobalHookRunner(previousRegistry);
      const release = previous.reserveReplacement();
      previous.quiesce();

      const dispatch = run(expectGlobalHookRunner(mod.getGlobalHookRunner()));
      await setImmediate();
      expect(currentHandler).not.toHaveBeenCalled();
      setActivePluginRegistry(currentRegistry);
      mod.initializeGlobalHookRunner(currentRegistry);
      release();

      await expect(dispatch).resolves.toBeUndefined();
      expect(previousHandler).not.toHaveBeenCalled();
      expect(currentHandler).toHaveBeenCalledOnce();
    },
  );

  it("re-selects every registration of a plugin a sequential dispatch waited out", async () => {
    const { PluginInstance } = await import("./plugin-instance.js");
    const previous = new PluginInstance("swap-policy");
    const current = new PluginInstance("swap-policy");
    const previousHandler = vi.fn();
    const calls: string[] = [];
    const registration = (instance: InstanceType<typeof PluginInstance>, label: string) => ({
      hookName: "before_tool_call",
      pluginId: "swap-policy",
      handler: instance.wrap(label === "previous" ? previousHandler : () => void calls.push(label)),
    });
    const previousRegistry = createMockPluginRegistry([
      { ...registration(previous, "previous"), priority: 2 },
      { ...registration(previous, "previous"), priority: 1 },
    ]);
    const currentRegistry = createMockPluginRegistry([
      { ...registration(current, "first"), priority: 2 },
      { ...registration(current, "second"), priority: 1 },
    ]);
    const mod = await importHookRunnerGlobalModule();
    setActivePluginRegistry(previousRegistry);
    mod.initializeGlobalHookRunner(previousRegistry);
    const release = previous.reserveReplacement();
    previous.quiesce();

    const dispatch = expectGlobalHookRunner(mod.getGlobalHookRunner()).runBeforeToolCall(
      { toolName: "read", params: {} },
      { toolName: "read" },
    );
    await setImmediate();
    setActivePluginRegistry(currentRegistry);
    mod.initializeGlobalHookRunner(currentRegistry);
    release();
    // The retired generation stops accepting entirely once its reload settles.
    await previous.dispose();

    await expect(dispatch).resolves.toBeUndefined();
    expect(previousHandler).not.toHaveBeenCalled();
    expect(calls).toEqual(["first", "second"]);
  });

  it("re-admits hook dispatch against the current registry after its prepared generation retires", async () => {
    const retiredHandler = vi.fn(() => {
      throw new PluginInstanceUnavailableError("retired-policy");
    });
    const currentHandler = vi.fn();
    const retiredRegistry = createMockPluginRegistry([
      { hookName: "before_tool_call", pluginId: "retired-policy", handler: retiredHandler },
    ]);
    const currentRegistry = createMockPluginRegistry([
      { hookName: "before_tool_call", pluginId: "current-policy", handler: currentHandler },
    ]);
    const metadataSnapshot = createPluginMetadataSnapshotFixture();
    const mod = await importHookRunnerGlobalModule();
    setActivePluginRegistry(currentRegistry);
    mod.initializeGlobalHookRunner(currentRegistry);

    await withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: retiredRegistry },
      async () => {
        markPluginRegistryRetired(retiredRegistry);
        await expect(
          expectGlobalHookRunner(mod.getGlobalHookRunner()).runBeforeToolCall(
            { toolName: "read", params: {} },
            { toolName: "read" },
          ),
        ).resolves.toBeUndefined();
      },
    );

    expect(retiredHandler).not.toHaveBeenCalled();
    expect(currentHandler).toHaveBeenCalledOnce();
  });

  it.each([
    {
      hookName: "before_tool_call" as const,
      run: (runner: HookRunner) =>
        runner.runBeforeToolCall({ toolName: "read", params: {} }, { toolName: "read" }),
    },
    {
      hookName: "before_install" as const,
      run: (runner: HookRunner) =>
        runner.runBeforeInstall(
          {
            targetName: "demo",
            targetType: "plugin",
            sourcePath: "/tmp/demo",
            sourcePathKind: "directory",
            origin: "local",
            request: { kind: "plugin-dir", mode: "install" },
            builtinScan: {
              status: "ok",
              scannedFiles: 0,
              critical: 0,
              warn: 0,
              info: 0,
              findings: [],
            },
          },
          { origin: "local", targetType: "plugin", requestKind: "plugin-dir" },
        ),
    },
  ])("fails closed when a default-bounded $hookName handler hangs", async ({ hookName, run }) => {
    vi.useFakeTimers();
    let releaseHandler: (() => void) | undefined;
    const registry = createMockPluginRegistry([
      {
        hookName,
        pluginId: "hanging-policy",
        handler: () =>
          new Promise<void>((resolve) => {
            releaseHandler = resolve;
          }),
      },
    ]);
    const mod = await importHookRunnerGlobalModule();
    setActivePluginRegistry(registry);
    mod.initializeGlobalHookRunner(registry);
    const pending = run(expectGlobalHookRunner(mod.getGlobalHookRunner()));

    try {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const rejection = expect(pending).rejects.toThrow(
        `${hookName} handler from hanging-policy failed: timed out after 15000ms`,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
    } finally {
      releaseHandler?.();
      await pending.catch(() => undefined);
    }
  });

  it("bounds gateway_stop handlers and lets shutdown continue", async () => {
    vi.useFakeTimers();
    let releaseHandler: (() => void) | undefined;
    const registry = createMockPluginRegistry([
      {
        hookName: "gateway_stop",
        pluginId: "hanging-shutdown",
        handler: () =>
          new Promise<void>((resolve) => {
            releaseHandler = resolve;
          }),
      },
    ]);
    const mod = await importHookRunnerGlobalModule();
    setActivePluginRegistry(registry);
    mod.initializeGlobalHookRunner(registry);
    const pending = mod.runGlobalGatewayStopSafely({
      event: { reason: "test shutdown" },
      ctx: {},
    });

    try {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      releaseHandler?.();
      await pending;
    }
  });
});
