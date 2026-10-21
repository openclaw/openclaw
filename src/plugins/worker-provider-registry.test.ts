import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { createTestPluginRegistry as createTestRegistry } from "./registry-runtime.test-helpers.js";
import type { WorkerProvider } from "./types.js";
import { resolveDurableWorkerProviderAutoEnabledReasons } from "./worker-provider-manifest.js";

function createWorkerProvider(id: string): WorkerProvider {
  return {
    id,
    resolveAllocation: async () => ({ leaseId: "unused", sharedHost: false }),
    provision: async () => {
      throw new Error("not called");
    },
    inspect: async () => ({ status: "unknown" }),
    destroy: async () => {},
  };
}

function createOwner(id: string, workerProviders: string[] = []) {
  return createPluginRecord({
    id,
    name: id,
    source: `/tmp/${id}/index.js`,
    origin: "global",
    enabled: true,
    contracts: { workerProviders },
    configSchema: false,
  });
}

function expectRejected(
  provider: WorkerProvider,
  message: unknown,
  declaredIds = ["static-ssh"],
  diagnostic = {},
) {
  const { registry, registerWorkerProvider } = createTestRegistry();
  registerWorkerProvider(createOwner("owner", declaredIds), provider);
  expect(registry.workerProviders.size).toBe(0);
  expect(registry.diagnostics).toContainEqual(expect.objectContaining({ message, ...diagnostic }));
}

describe("worker provider registry", () => {
  it("rejects registrations missing manifest ownership", () => {
    expectRejected(
      createWorkerProvider("static-ssh"),
      "plugin must declare contracts.workerProviders for provider: static-ssh",
      [],
      { level: "error", pluginId: "owner" },
    );
  });

  it("rejects a missing resolveAllocation method", () => {
    const provider = createWorkerProvider("static-ssh");
    delete (provider as Partial<WorkerProvider>).resolveAllocation;
    expectRejected(provider, "worker provider registration missing method: resolveAllocation");
  });

  it.each([
    ["renew", "later", "must be a function"],
    ["runSetupCommand", "later", "must be a function"],
    ["resolveSshIdentity", "later", "must be a function"],
    ["provisionBeforeInstallation", "sometimes", "must be a boolean"],
  ])("rejects an invalid %s declaration", (field, value, error) => {
    const provider = createWorkerProvider("static-ssh");
    Reflect.set(provider, String(field), value);
    expectRejected(provider, `worker provider registration ${field} ${error}`);
  });

  it("rejects an unknown mode in a placement declaration", () => {
    const provider = createWorkerProvider("static-ssh");
    Reflect.set(provider, "supportedExecutionModes", ["unsupported"]);
    expectRejected(
      provider,
      expect.stringContaining("worker provider registration supportedExecutionModes"),
    );
  });

  it("registers both placement modes in canonical order", () => {
    const pluginRegistry = createTestRegistry();
    const provider = {
      ...createWorkerProvider("static-ssh"),
      supportedExecutionModes: ["worker-turn", "remote-exec"],
    } satisfies WorkerProvider;

    pluginRegistry.registerWorkerProvider(createOwner("owner", ["static-ssh"]), provider);

    expect(pluginRegistry.registry.workerProviders.get("static-ssh")?.provider).toBe(provider);
    expect(pluginRegistry.registry.diagnostics).toEqual([]);
  });

  it("rejects invalid provider ids", () => {
    expectRejected(
      createWorkerProvider("__proto__"),
      "worker provider registration missing valid id",
      ["__proto__"],
      { level: "error", pluginId: "owner" },
    );
  });

  it("rejects normalized duplicate provider ids", () => {
    const pluginRegistry = createTestRegistry();
    pluginRegistry.registerWorkerProvider(
      createOwner("first", ["static-ssh"]),
      createWorkerProvider("Static-SSH"),
    );

    pluginRegistry.registerWorkerProvider(
      createOwner("second", ["static-ssh"]),
      createWorkerProvider(" static-ssh "),
    );

    expect(pluginRegistry.registry.workerProviders.size).toBe(1);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
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
