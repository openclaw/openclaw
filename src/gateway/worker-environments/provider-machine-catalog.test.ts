import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createWorkerMachineCatalog } from "./provider-machine-catalog.js";

function fixture(resolveDisplayId?: WorkerProvider["resolveDisplayId"]) {
  const config: OpenClawConfig = {
    cloudWorkers: {
      profiles: {
        production: { provider: "adapter", settings: { backend: "aws", setup: "private fixture" } },
        aws: { provider: "adapter", settings: { backend: "azure" } },
      },
    },
  };
  const listMachineOptions = vi.fn(async () => [{ id: "standard", label: "Standard" }]);
  const provider: WorkerProvider = {
    id: "adapter",
    resolveDisplayId,
    listMachineOptions,
    resolveAllocation: vi.fn(),
    provision: vi.fn(),
    inspect: vi.fn(),
    destroy: vi.fn(),
  };
  let activeProvider: WorkerProvider | undefined = provider;
  const warn = vi.fn();
  const catalog = createWorkerMachineCatalog({
    getConfig: () => config,
    resolveProvider: () => activeProvider,
    warn,
  });
  return {
    config,
    catalog,
    provider,
    warn,
    setProvider: (next: WorkerProvider | undefined) => {
      activeProvider = next;
    },
  };
}

describe("profile backend display identity", () => {
  it("reflects profile snapshots and live provider replacement", async () => {
    const resolveDisplayId = vi.fn<NonNullable<WorkerProvider["resolveDisplayId"]>>((profile) =>
      typeof profile.backend === "string" ? profile.backend : undefined,
    );
    const { config, catalog, provider, setProvider } = fixture(resolveDisplayId);
    expect(catalog.readProviderDisplayId("production")).toBe("aws");
    expect(catalog.readProviderDisplayId("aws")).toBe("azure");
    config.cloudWorkers!.profiles!.production!.settings = { backend: "hetzner" };
    expect(catalog.readProviderDisplayId("production")).toBe("hetzner");
    await expect(catalog.listMachineOptions("production")).resolves.toEqual([
      { id: "standard", label: "Standard" },
    ]);
    expect(catalog.readProviderDisplayId("missing")).toBeUndefined();
    delete config.cloudWorkers!.profiles!.production;
    expect(catalog.readProviderDisplayId("production")).toBeUndefined();
    config.cloudWorkers!.profiles!.production = {
      provider: "adapter",
      settings: { backend: "aws" },
    };
    setProvider(undefined);
    expect(catalog.readProviderDisplayId("production")).toBeUndefined();
    setProvider(provider);
    expect(catalog.readProviderDisplayId("production")).toBe("aws");
    setProvider({ ...provider, resolveDisplayId: () => "gcp" });
    expect(catalog.readProviderDisplayId("production")).toBe("gcp");
    await expect(catalog.listMachineOptions("production")).resolves.toHaveLength(1);
    expect(catalog.readProviderDisplayId("production")).toBe("gcp");

    setProvider(undefined);
    expect(catalog.readProviderDisplayId("production")).toBeUndefined();
  });

  it.each([
    "",
    "AWS",
    "aws\n",
    "a".repeat(65),
    "a_b",
    undefined,
    new Error("private provider details"),
  ])("keeps unusable metadata %j cosmetic and private", async (value) => {
    const { catalog, warn } = fixture(
      value === undefined
        ? undefined
        : () => {
            if (value instanceof Error) {
              throw value;
            }
            return value;
          },
    );
    expect(catalog.readProviderDisplayId("production")).toBeUndefined();
    await expect(catalog.listMachineOptions("production")).resolves.toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

type Section = "machines" | "systems";
const choices = [{ id: "linux", label: "Linux" }];

function discoveryFixture(section: Section) {
  const state = fixture();
  const pending = createDeferred<readonly { id: string; label: string }[]>();
  const hook = vi.fn(() => pending.promise);
  const operation = section === "machines" ? "listMachineOptions" : "listOperatingSystems";
  Object.assign(state.provider, { [operation]: hook });
  const read = () =>
    section === "machines"
      ? state.catalog.listMachineOptions("production")
      : state.catalog.listOperatingSystems("production");
  return { ...state, pending, hook, read, operation };
}

describe("provider metadata in-flight ownership", () => {
  it.each([
    ["machines", false],
    ["systems", false],
    ["machines", true],
    ["systems", true],
  ] as const)(
    "coalesces %s reads and refreshes after settlement (rejected=%s)",
    async (section, rejected) => {
      const { catalog, pending, hook, read, provider, setProvider, operation, warn } =
        discoveryFixture(section);
      const first = read();
      const second = read();
      const settled = Promise.allSettled([first, second]);
      const failure = new Error("metadata unavailable");
      if (rejected) {
        pending.reject(failure);
      } else {
        catalog.warmMachineShape("production");
        catalog.warmMachineShape("production");
        pending.resolve(choices);
      }
      const expected = rejected
        ? { status: "rejected", reason: failure }
        : { status: "fulfilled", value: choices };
      expect(await settled).toEqual([expected, expected]);
      expect(hook).toHaveBeenCalledOnce();
      hook.mockResolvedValue(choices);
      expect(await read()).toEqual(choices);
      expect(hook).toHaveBeenCalledTimes(2);
      const updated = [{ id: "updated", label: "Updated" }];
      const refreshedHook = vi.fn(async () => updated);
      setProvider({ ...provider, [operation]: refreshedHook });
      expect(await read()).toEqual(updated);
      refreshedHook.mockResolvedValue(choices);
      expect(await read()).toEqual(choices);
      expect(refreshedHook).toHaveBeenCalledTimes(2);
      expect(hook).toHaveBeenCalledTimes(2);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("retries a failed section while joining the sibling's pending warmup work", async () => {
    const { catalog, provider, warn } = fixture();
    const systems = createDeferred<readonly { id: string; label: string }[]>();
    const reported = createDeferred();
    const failure = new Error("machine metadata unavailable");
    const listMachineOptions = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(choices);
    const listOperatingSystems = vi.fn(() => systems.promise);
    warn.mockImplementation(() => reported.resolve());
    Object.assign(provider, { listMachineOptions, listOperatingSystems });
    catalog.warmMachineShape("production");
    await expect(catalog.listMachineOptions("production")).rejects.toBe(failure);

    try {
      catalog.warmMachineShape("production");
      expect(listMachineOptions).toHaveBeenCalledTimes(2);
      expect(listOperatingSystems).toHaveBeenCalledOnce();
      await expect(catalog.listMachineOptions("production")).resolves.toEqual(choices);
      expect(listMachineOptions).toHaveBeenCalledTimes(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      systems.resolve(choices);
      await reported.promise;
    }
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Worker machine catalog warmup failed for profile production",
    );
  });

  it("does not retain old machine shape after a fresh empty response", async () => {
    const { provider, catalog } = fixture();
    const listMachineOptions = vi.fn(async () => [{ id: "standard", label: "Standard", cpu: 4 }]);
    Object.assign(provider, { listMachineOptions });
    const record = {
      providerId: "adapter",
      profileId: "production",
      profileSnapshot: {
        settings: { backend: "aws", setup: "private fixture" },
        machineClass: "standard",
      },
    };
    await catalog.listMachineOptions("production");
    expect(catalog.readMachineShape(record)).toHaveProperty("cpu", 4);
    listMachineOptions.mockResolvedValue([]);
    await catalog.listMachineOptions("production");
    expect(catalog.readMachineShape(record)).not.toHaveProperty("cpu");
    expect(listMachineOptions).toHaveBeenCalledTimes(2);
  });
});
