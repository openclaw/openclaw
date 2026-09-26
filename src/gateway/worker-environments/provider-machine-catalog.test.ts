import { describe, expect, it, vi } from "vitest";
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
  const catalog = createWorkerMachineCatalog({
    getConfig: () => config,
    resolveProvider: () => activeProvider,
    warn,
    requireWorkerProfile: (value) =>
      requireWorkerProfile(value, (_code, message) => new Error(message)),
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
