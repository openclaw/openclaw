import { afterEach, describe, expect, it, vi } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { startLazyPluginServiceModule } from "./lazy-service-module.js";

function createLazyModuleLifecycle() {
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  return { start, stop, module: { startDefault: start, stopDefault: stop } };
}

function startService(params: Partial<Parameters<typeof startLazyPluginServiceModule>[0]>) {
  return startLazyPluginServiceModule({
    loadDefaultModule: async () => createLazyModuleLifecycle().module,
    startExportNames: ["startDefault"],
    ...params,
  });
}

describe("startLazyPluginServiceModule", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_LAZY_SERVICE_SKIP;
    delete process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE;
  });

  it("starts the default module and returns its stop hook", async () => {
    const lifecycle = createLazyModuleLifecycle();

    const handle = await startService({
      loadDefaultModule: async () => lifecycle.module,
      stopExportNames: ["stopDefault"],
    });

    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    if (!handle) {
      throw new Error("Expected lazy plugin service handle");
    }
    expect(handle.stop).toBeTypeOf("function");
    await handle.stop();
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  });

  it("honors skip env before loading the module", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_SKIP = "1";
    const loadDefaultModule = vi.fn(async () => createLazyModuleLifecycle().module);

    const handle = await startService({
      skipEnvVar: "OPENCLAW_LAZY_SERVICE_SKIP",
      loadDefaultModule,
    });

    expect(handle).toBeNull();
    expect(loadDefaultModule).not.toHaveBeenCalled();
  });

  it("leaves caller-supplied override loaders responsible for their own specifiers", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE = "C:\\Users\\alice\\browser-service.mjs";
    const start = vi.fn(async () => {});
    const loadOverrideModule = vi.fn(async () => ({ startOverride: start }));

    await withMockedWindowsPlatform(async () => {
      await startService({
        overrideEnvVar: "OPENCLAW_LAZY_SERVICE_OVERRIDE",
        loadOverrideModule,
        startExportNames: ["startOverride"],
      });
    });

    expect(loadOverrideModule).toHaveBeenCalledWith("C:\\Users\\alice\\browser-service.mjs");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("validates the override specifier before loading it", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE = "virtual:service";
    const loadOverrideModule = vi.fn(async () => ({ startOverride: vi.fn(async () => {}) }));
    const validateOverrideSpecifier = vi.fn((specifier: string) => `validated:${specifier}`);

    await startService({
      overrideEnvVar: "OPENCLAW_LAZY_SERVICE_OVERRIDE",
      validateOverrideSpecifier,
      loadOverrideModule,
      startExportNames: ["startOverride"],
    });

    expect(validateOverrideSpecifier).toHaveBeenCalledWith("virtual:service");
    expect(loadOverrideModule).toHaveBeenCalledWith("validated:virtual:service");
  });
});
