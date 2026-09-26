import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createWorkerMachineCatalog } from "./provider-machine-catalog.js";
import { requireWorkerProfile } from "./service-validation.js";

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
  const resolveProvider = vi.fn(() => activeProvider);
  const catalog = createWorkerMachineCatalog({
    getConfig: () => config,
    resolveProvider,
    warn,
    requireWorkerProfile: (value) =>
      requireWorkerProfile(value, (_code, message) => new Error(message)),
  });
  return {
    config,
    catalog,
    provider,
    resolveProvider,
    warn,
    setProvider: (next: WorkerProvider | undefined) => {
      activeProvider = next;
    },
  };
}

describe("profile backend display identity", () => {
  it("caches only provider-authored presentation with the existing settings snapshot", async () => {
    const resolveDisplayId = vi.fn<NonNullable<WorkerProvider["resolveDisplayId"]>>((profile) =>
      typeof profile.backend === "string" ? profile.backend : undefined,
    );
    const { config, catalog } = fixture(resolveDisplayId);
    expect(catalog.readProviderDisplayId("production")).toBe("aws");
    expect(catalog.readProviderDisplayId("production")).toBe("aws");
    expect(resolveDisplayId).toHaveBeenCalledOnce();
    expect(catalog.readProviderDisplayId("aws")).toBe("azure");
    config.cloudWorkers!.profiles!.production!.settings = { backend: "hetzner" };
    expect(catalog.readProviderDisplayId("production")).toBe("hetzner");
    expect(resolveDisplayId).toHaveBeenCalledTimes(3);
    await expect(catalog.listMachineOptions("production")).resolves.toEqual([
      { id: "standard", label: "Standard" },
    ]);
    expect(catalog.readProviderDisplayId("missing")).toBeUndefined();
    delete config.cloudWorkers!.profiles!.production;
    expect(catalog.readProviderDisplayId("production")).toBeUndefined();
  });

  it("refreshes display metadata when the live provider binding changes", async () => {
    const firstHook = vi.fn(() => "aws");
    const { catalog, provider, setProvider } = fixture(firstHook);
    setProvider(undefined);
    expect(catalog.readProviderDisplayId("production")).toBeUndefined();

    setProvider(provider);
    expect(catalog.readProviderDisplayId("production")).toBe("aws");
    expect(catalog.readProviderDisplayId("production")).toBe("aws");
    expect(firstHook).toHaveBeenCalledOnce();

    const reloadedHook = vi.fn(() => "gcp");
    setProvider({ ...provider, resolveDisplayId: reloadedHook });
    expect(catalog.readProviderDisplayId("production")).toBe("gcp");
    await expect(catalog.listMachineOptions("production")).resolves.toHaveLength(1);
    expect(catalog.readProviderDisplayId("production")).toBe("gcp");
    expect(reloadedHook).toHaveBeenCalledOnce();

    setProvider(undefined);
    expect(catalog.readProviderDisplayId("production")).toBeUndefined();
  });

  it.each([
    undefined,
    "",
    "AWS",
    " aws",
    "aws ",
    "aws\n",
    "a".repeat(65),
    "https://example.test",
    "a_b",
  ])("omits invalid metadata %j without losing machine choices", async (value) => {
    const { catalog } = fixture(() => value);
    expect(catalog.readProviderDisplayId("production")).toBeUndefined();
    await expect(catalog.listMachineOptions("production")).resolves.toHaveLength(1);
  });

  it("keeps missing and throwing hooks cosmetic without exposing their error", async () => {
    expect(fixture().catalog.readProviderDisplayId("production")).toBeUndefined();
    const hook = vi.fn(() => {
      throw new Error("private provider details");
    });
    const { catalog, warn } = fixture(hook);
    expect(catalog.readProviderDisplayId("production")).toBeUndefined();
    await expect(catalog.listMachineOptions("production")).resolves.toHaveLength(1);
    expect(hook).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });
});

type Section = "machines" | "systems";
const choices = [{ id: "linux", label: "Linux" }];

function discoveryFixture(section: Section) {
  const state = fixture();
  const pending = createDeferred<readonly { id: string; label: string }[]>();
  const hook = vi.fn(() => pending.promise);
  Object.assign(state.provider, {
    [section === "machines" ? "listMachineOptions" : "listOperatingSystems"]: hook,
  });
  const read = () =>
    section === "machines"
      ? state.catalog.listMachineOptions("production")
      : state.catalog.listOperatingSystems("production");
  return { ...state, pending, hook, read };
}

describe("provider metadata in-flight ownership", () => {
  it.each(["machines", "systems"] as const)(
    "coalesces concurrent %s reads but refreshes after settlement",
    async (section) => {
      const { pending, hook, read } = discoveryFixture(section);
      const first = read();
      const second = read();
      pending.resolve(choices);
      expect(await Promise.all([first, second])).toEqual([choices, choices]);
      expect(hook).toHaveBeenCalledOnce();
      const updated = [{ id: "updated", label: "Updated" }];
      hook.mockResolvedValue(updated);
      expect(await read()).toEqual(updated);
      expect(hook).toHaveBeenCalledTimes(2);
    },
  );

  it("joins active machine and operating-system work during warmup", async () => {
    const { catalog, provider, warn } = fixture();
    const machines = createDeferred<readonly { id: string; label: string }[]>();
    const systems = createDeferred<readonly { id: string; label: string }[]>();
    const listMachineOptions = vi.fn(() => machines.promise);
    const listOperatingSystems = vi.fn(() => systems.promise);
    Object.assign(provider, { listMachineOptions, listOperatingSystems });
    const first = catalog.listMachineOptions("production");
    const second = catalog.listOperatingSystems("production");
    catalog.warmMachineShape("production");
    catalog.warmMachineShape("production");
    machines.resolve(choices);
    systems.resolve(choices);
    await Promise.all([first, second]);
    expect(listMachineOptions).toHaveBeenCalledOnce();
    expect(listOperatingSystems).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["machines", "systems"] as const)("retries a rejected %s flight", async (section) => {
    const { pending, hook, read } = discoveryFixture(section);
    const settled = Promise.allSettled([read(), read()]);
    const failure = new Error("metadata unavailable");
    pending.reject(failure);
    expect(await settled).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(hook).toHaveBeenCalledOnce();
    hook.mockResolvedValue(choices);
    expect(await read()).toEqual(choices);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it.each(["settings", "provider"] as const)(
    "isolates a replacement %s generation from an old flight",
    async (replacement) => {
      const { pending, hook, read, config, catalog, provider, setProvider } =
        discoveryFixture("machines");
      const oldRead = read();
      const current = createDeferred<readonly { id: string; label: string }[]>();
      const nextHook = vi.fn(() => current.promise);
      if (replacement === "settings") {
        config.cloudWorkers!.profiles!.production!.settings = { backend: "azure" };
        hook.mockImplementation(() => current.promise);
      } else {
        setProvider({ ...provider, listMachineOptions: nextHook });
      }
      const currentReads = [read(), read()];
      const currentChoices = [{ id: "current", label: "Current" }];
      current.resolve(currentChoices);
      expect(await Promise.all(currentReads)).toEqual([currentChoices, currentChoices]);
      const version = catalog.machineShapeVersion();
      pending.resolve(choices);
      expect(await oldRead).toEqual(choices);
      expect(catalog.machineShapeVersion()).toBe(version);
      if (replacement === "settings") {
        expect(hook).toHaveBeenCalledTimes(2);
      } else {
        expect(hook).toHaveBeenCalledOnce();
        expect(nextHook).toHaveBeenCalledOnce();
      }
    },
  );

  it("uses the provider binding captured for the selected catalog", async () => {
    const { pending, hook, read, provider, resolveProvider } = discoveryFixture("machines");
    const otherHook = vi.fn(async () => [{ id: "other", label: "Other" }]);
    resolveProvider.mockReturnValueOnce(provider).mockReturnValue({
      ...provider,
      listMachineOptions: otherHook,
    });
    const result = read();
    pending.resolve(choices);
    expect(await result).toEqual(choices);
    expect(hook).toHaveBeenCalledOnce();
    expect(otherHook).not.toHaveBeenCalled();
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
