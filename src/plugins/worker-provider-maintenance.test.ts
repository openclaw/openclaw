import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginRecord } from "./loader-records.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import type { WorkerProvider } from "./types.js";
import { maintainConfiguredWorkerProviders } from "./worker-provider-maintenance.js";

type MaintenanceContext = Parameters<NonNullable<WorkerProvider["maintain"]>>[0];

function createHarness() {
  const registry = createEmptyPluginRegistry();
  const owner = createPluginRecord({
    id: "worker-owner",
    source: "/synthetic/worker-owner/index.js",
    origin: "bundled",
    enabled: true,
    configSchema: false,
    contracts: { workerProviders: ["cloud-a", "cloud-b"] },
  });
  registry.plugins.push(owner);
  markPluginRegistryActive(registry);
  let currentRegistry = registry;
  const profiles: NonNullable<NonNullable<OpenClawConfig["cloudWorkers"]>["profiles"]> = {
    project: { provider: "cloud-a", settings: { location: "one" } },
  };
  const config: OpenClawConfig = { cloudWorkers: { profiles } };
  const controller = new AbortController();
  const warn = vi.fn<(message: string) => void>();
  const addProvider = (id: string, maintain: NonNullable<WorkerProvider["maintain"]>) => {
    const provider: WorkerProvider = {
      id,
      maintain,
      resolveAllocation: async () => ({ leaseId: "unused", sharedHost: false }),
      provision: async () => {
        throw new Error("unused");
      },
      inspect: async () => ({ status: "unknown" }),
      destroy: async () => {},
    };
    registry.workerProviders.set(id, { pluginId: owner.id, provider, source: owner.source });
    return provider;
  };
  return {
    registry,
    owner,
    config,
    profiles,
    controller,
    warn,
    addProvider,
    replaceRegistry: () => {
      currentRegistry = createEmptyPluginRegistry();
      markPluginRegistryActive(currentRegistry);
    },
    useUnactivatedRegistry: () => {
      currentRegistry = createEmptyPluginRegistry();
      currentRegistry.plugins.push(owner);
      currentRegistry.workerProviders = registry.workerProviders;
    },
    run: () =>
      maintainConfiguredWorkerProviders({
        getRegistry: () => currentRegistry,
        getConfig: () => config,
        signal: controller.signal,
        warn,
      }),
  };
}

describe("configured worker provider maintenance", () => {
  it("batches normalized profiles, preserves the receiver, and isolates mutable settings", async () => {
    const harness = createHarness();
    harness.profiles.second = {
      provider: " CLOUD-A ",
      settings: { nested: { location: "two" } },
    };
    let retained: MaintenanceContext | undefined;
    const maintain = vi.fn(async function (this: WorkerProvider, context: MaintenanceContext) {
      expect(this).toBe(provider);
      expect(context.profiles).toEqual([{ location: "one" }, { nested: { location: "two" } }]);
      const nested = context.profiles[1]!.nested as { location: string };
      nested.location = "changed by plugin";
      context.assertCurrent();
      retained = context;
    });
    const provider = harness.addProvider("cloud-a", maintain);

    await harness.run();

    expect(maintain).toHaveBeenCalledTimes(1);
    expect(harness.profiles.second.settings).toEqual({
      nested: { location: "two" },
    });
    expect(retained).toBeDefined();
    expect(() => retained!.assertCurrent()).toThrow("no longer current");
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["registry replacement", (h: ReturnType<typeof createHarness>) => h.replaceRegistry()],
    ["registry retirement", (h) => markPluginRegistryRetired(h.registry)],
    [
      "same-object reactivation",
      (h) => {
        markPluginRegistryRetired(h.registry);
        markPluginRegistryActive(h.registry);
      },
    ],
    ["owner disablement", (h) => (h.owner.enabled = false)],
    ["owner removal", (h) => (h.registry.plugins.length = 0)],
    ["registration replacement", (h) => h.addProvider("cloud-a", async () => {})],
    ["settings mutation", (h) => (h.profiles.project!.settings!.location = "changed")],
    ["profile removal", (h) => delete h.profiles.project],
    ["plugin policy change", (h) => (h.config.plugins = { enabled: false })],
    ["abort", (h: ReturnType<typeof createHarness>) => h.controller.abort()],
  ] satisfies [string, (h: ReturnType<typeof createHarness>) => void][])(
    "rejects effects after awaited work across %s",
    async (_label, invalidate) => {
      const harness = createHarness();
      const entered = createDeferredCore<MaintenanceContext>();
      const resume = createDeferredCore();
      const effect = vi.fn();
      harness.addProvider("cloud-a", async (context) => {
        entered.resolve(context);
        await resume.promise;
        context.assertCurrent();
        effect();
      });
      const operation = harness.run();
      const context = await entered.promise;
      expect(() => context.assertCurrent()).not.toThrow();

      invalidate(harness);
      resume.resolve();
      await operation;

      expect(effect).not.toHaveBeenCalled();
      expect(() => context.assertCurrent()).toThrow();
    },
  );

  it.each([
    ["unactivated", (h) => h.useUnactivatedRegistry()],
    ["disabled", (h) => (h.owner.enabled = false)],
    ["missing", (h) => (h.registry.plugins.length = 0)],
    ["unconfigured", (h) => (h.config.cloudWorkers!.profiles = {})],
    ["denylisted", (h) => (h.config.plugins = { deny: [" WORKER-OWNER "] })],
    ["excluded-by-allowlist", (h) => (h.config.plugins = { allow: ["another-owner"] })],
    [
      "disabled-normalized-entry",
      (h) => (h.config.plugins = { entries: { " WORKER-OWNER ": { enabled: false } } }),
    ],
  ] satisfies [string, (h: ReturnType<typeof createHarness>) => void][])(
    "does not invoke an %s owner",
    async (_kind, prepare) => {
      const harness = createHarness();
      const maintain = vi.fn(async () => {});
      harness.addProvider("cloud-a", maintain);
      prepare(harness);
      await harness.run();
      expect(maintain).not.toHaveBeenCalled();
    },
  );

  it("isolates provider failures and invalid settings without logging provider error text", async () => {
    const harness = createHarness();
    const second = vi.fn(async () => {});
    harness.addProvider("cloud-a", async () => {
      throw new Error("synthetic credential material must not be logged");
    });
    harness.addProvider("cloud-b", second);
    harness.profiles.other = { provider: "cloud-b", settings: {} };

    await harness.run();
    expect(second).toHaveBeenCalledTimes(1);
    expect(harness.warn.mock.calls).toEqual([["Worker provider maintenance failed (cloud-a)"]]);

    const invalid = vi.fn(async () => {});
    harness.addProvider("cloud-a", invalid);
    harness.profiles.project!.settings = { token: "synthetic plaintext" };
    await harness.run();

    expect(invalid).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
    expect(harness.warn).toHaveBeenLastCalledWith(
      "Worker provider maintenance skipped invalid settings (cloud-a)",
    );
  });
});
