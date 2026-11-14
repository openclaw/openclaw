import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as bundledDiscovery from "./bundled-discovery-state.js";
import { createPluginRecord } from "./loader-records.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createTestPluginRegistry as createTestRegistry } from "./registry-runtime.test-helpers.js";
import type { WorkerProvider } from "./types.js";
import { maintainConfiguredWorkerProviders } from "./worker-provider-maintenance.js";
import { resolveDurableWorkerProviderAutoEnabledReasons } from "./worker-provider-manifest.js";

function createWorkerProvider(id: string, maintain?: WorkerProvider["maintain"]): WorkerProvider {
  return {
    id,
    ...(maintain ? { maintain } : {}),
    resolveAllocation: async () => ({ leaseId: "unused", sharedHost: false }),
    provision: async () => {
      throw new Error(maintain ? "unused" : "not called");
    },
    inspect: async () => ({ status: "unknown" }),
    destroy: async () => {},
  };
}

function createOwner(
  id: string,
  workerProviders: string[] = [],
  overrides: Partial<Parameters<typeof createPluginRecord>[0]> = {},
) {
  return createPluginRecord({
    id,
    source: `/tmp/${id}/index.js`,
    origin: "global",
    enabled: true,
    contracts: { workerProviders },
    configSchema: false,
    ...overrides,
  });
}

function expectRejected(provider: WorkerProvider, message: unknown, declaredIds = ["static-ssh"]) {
  const { registry, registerWorkerProvider } = createTestRegistry();
  registerWorkerProvider(createOwner("owner", declaredIds), provider);
  expect(registry.workerProviders.size).toBe(0);
  expect(registry.diagnostics).toContainEqual(
    expect.objectContaining({ message, level: "error", pluginId: "owner" }),
  );
}

describe("worker provider registry", () => {
  it("rejects registrations missing manifest ownership", () => {
    expectRejected(
      createWorkerProvider("static-ssh"),
      "plugin must declare contracts.workerProviders for provider: static-ssh",
      [],
    );
  });

  it.each([
    ["resolveAllocation", undefined, "missing method: resolveAllocation"],
    ["renew", "later", "renew must be a function"],
    ["runSetupCommand", "later", "runSetupCommand must be a function"],
    ["resolveSshIdentity", "later", "resolveSshIdentity must be a function"],
    ["provisionBeforeInstallation", "sometimes", "provisionBeforeInstallation must be a boolean"],
    [
      "supportedExecutionModes",
      ["unsupported"],
      expect.stringContaining("worker provider registration supportedExecutionModes"),
    ],
    ["id", "__proto__", "missing valid id"],
  ] as const)("rejects an invalid %s declaration", (field, value, error) => {
    const provider = createWorkerProvider("static-ssh");
    if (value === undefined) {
      Reflect.deleteProperty(provider, field);
    } else {
      Reflect.set(provider, field, value);
    }
    expectRejected(
      provider,
      typeof error === "string" ? `worker provider registration ${error}` : error,
      field === "id" ? ["__proto__"] : undefined,
    );
  });

  it("registers both placement modes in canonical order", () => {
    const { registry, registerWorkerProvider: register } = createTestRegistry();
    const provider = {
      ...createWorkerProvider("static-ssh"),
      supportedExecutionModes: ["worker-turn", "remote-exec"],
    } satisfies WorkerProvider;

    register(createOwner("owner", ["static-ssh"]), provider);

    expect(registry.workerProviders.get("static-ssh")?.provider).toBe(provider);
    expect(registry.diagnostics).toEqual([]);
  });

  it("rejects normalized duplicate provider ids", () => {
    const { registry, registerWorkerProvider: register } = createTestRegistry();
    register(createOwner("first", ["static-ssh"]), createWorkerProvider("Static-SSH"));
    register(createOwner("second", ["static-ssh"]), createWorkerProvider(" static-ssh "));

    expect(registry.workerProviders.size).toBe(1);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "second",
        message: "worker provider already registered: static-ssh (first)",
      }),
    );
  });

  it("auto-enables only bundled owners needed by durable leases", () => {
    const reasons = resolveDurableWorkerProviderAutoEnabledReasons(
      {
        plugins: [
          {
            id: "qa-lab",
            origin: "bundled",
            contracts: { workerProviders: ["other", "static-ssh"] },
          },
          {
            id: "external-workers",
            origin: "global",
            contracts: { workerProviders: ["cloud-vendor"] },
          },
        ],
        diagnostics: [],
      } as never,
      [" STATIC-SSH ", "cloud-vendor"],
    );

    expect(reasons).toEqual({ "qa-lab": ["static-ssh durable worker lease"] });
  });
});

type MaintenanceContext = Parameters<NonNullable<WorkerProvider["maintain"]>>[0];

function createHarness() {
  const registry = createEmptyPluginRegistry();
  const owner = createOwner("worker-owner", ["cloud-a", "cloud-b"], {
    origin: "bundled",
    source: "/synthetic/worker-owner/index.js",
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
    const provider = createWorkerProvider(id, maintain);
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

  it.each([
    ["bundled", true, (h: ReturnType<typeof createHarness>) => h],
    ["external", false, (h) => (h.owner.origin = "global")],
    ["globally disabled", false, (h) => (h.config.plugins!.enabled = false)],
    ["denylisted", false, (h) => (h.config.plugins!.deny = [h.owner.id])],
    [
      "explicitly disabled",
      false,
      (h) => (h.config.plugins!.entries = { [h.owner.id]: { enabled: false } }),
    ],
  ] satisfies [string, boolean, (h: ReturnType<typeof createHarness>) => unknown][])(
    "preserves bundled compatibility policy for an %s owner",
    async (_kind, allowed, prepare) => {
      const harness = createHarness();
      harness.config.plugins = { allow: ["another-owner"] };
      const maintain = vi.fn(async () => {});
      harness.addProvider("cloud-a", maintain);
      prepare(harness);
      await vi.spyOn(bundledDiscovery, "readBundledDiscoveryModeMemoized").withImplementation(
        () => "compat",
        () => harness.run(),
      );
      expect(maintain).toHaveBeenCalledTimes(allowed ? 1 : 0);
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
