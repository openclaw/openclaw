import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
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
  await expectDefined(handle, "lazy service handle").stop();
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

it.each(["C:\\Users\\alice\\browser-service.mjs", "virtual:service"])(
  "loads caller-owned override %s with optional validation",
  async (specifier) => {
    process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE = specifier;
    const start = vi.fn(async () => {});
    const loadOverrideModule = vi.fn(async () => ({ startOverride: start }));
    const validateOverrideSpecifier = specifier.startsWith("virtual:")
      ? vi.fn((value: string) => `validated:${value}`)
      : undefined;

    const load = () =>
      startService({
        overrideEnvVar: "OPENCLAW_LAZY_SERVICE_OVERRIDE",
        loadOverrideModule,
        validateOverrideSpecifier,
        startExportNames: ["startOverride"],
      });
    await (validateOverrideSpecifier ? load() : withMockedWindowsPlatform(load));

    expect(loadOverrideModule).toHaveBeenCalledWith(
      validateOverrideSpecifier ? `validated:${specifier}` : specifier,
    );
    expect(start).toHaveBeenCalledTimes(1);
    if (validateOverrideSpecifier) {
      expect(validateOverrideSpecifier).toHaveBeenCalledWith(specifier);
    }
  },
);
