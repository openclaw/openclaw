import { afterEach, describe, expect, it, vi } from "vitest";
import { startLazyPluginServiceModule } from "./lazy-service-module.js";

describe("startLazyPluginServiceModule", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_LAZY_SERVICE_SKIP;
    delete process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE;
  });

  it("starts the default module and returns its stop hook", async () => {
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});

    const handle = await startLazyPluginServiceModule({
      loadDefaultModule: async () => ({
        startDefault: start,
        stopDefault: stop,
      }),
      startExportNames: ["startDefault"],
      stopExportNames: ["stopDefault"],
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(handle).not.toBeNull();
    await handle?.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("honors skip env before loading the module", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_SKIP = "1";
    const loadDefaultModule = vi.fn(async () => ({ startDefault: vi.fn(async () => {}) }));

    const handle = await startLazyPluginServiceModule({
      skipEnvVar: "OPENCLAW_LAZY_SERVICE_SKIP",
      loadDefaultModule,
      startExportNames: ["startDefault"],
    });

    expect(handle).toBeNull();
    expect(loadDefaultModule).not.toHaveBeenCalled();
  });

  it("uses the override module when configured", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE = "virtual:service";
    const start = vi.fn(async () => {});
    const loadOverrideModule = vi.fn(async () => ({ startOverride: start }));

    await startLazyPluginServiceModule({
      overrideEnvVar: "OPENCLAW_LAZY_SERVICE_OVERRIDE",
      loadDefaultModule: async () => ({ startDefault: vi.fn(async () => {}) }),
      loadOverrideModule,
      startExportNames: ["startOverride", "startDefault"],
    });

    expect(loadOverrideModule).toHaveBeenCalledWith("virtual:service");
    expect(start).toHaveBeenCalledTimes(1);
  });
});
