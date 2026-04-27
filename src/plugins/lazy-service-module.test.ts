import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultLoadOverrideModule,
  startLazyPluginServiceModule,
} from "./lazy-service-module.js";

function createAsyncHookMock() {
  return vi.fn(async () => {});
}

function createLazyModuleLifecycle() {
  const start = createAsyncHookMock();
  const stop = createAsyncHookMock();
  return {
    start,
    stop,
    module: {
      startDefault: start,
      stopDefault: stop,
    },
  };
}

async function expectLifecycleStarted(params: {
  overrideEnvVar?: string;
  validateOverrideSpecifier?: (specifier: string) => string;
  loadDefaultModule?: () => Promise<Record<string, unknown>>;
  loadOverrideModule?: (spec: string) => Promise<Record<string, unknown>>;
  startExportNames: string[];
  stopExportNames?: string[];
}) {
  return startLazyPluginServiceModule({
    ...(params.overrideEnvVar ? { overrideEnvVar: params.overrideEnvVar } : {}),
    ...(params.validateOverrideSpecifier
      ? { validateOverrideSpecifier: params.validateOverrideSpecifier }
      : {}),
    loadDefaultModule: params.loadDefaultModule ?? (async () => createLazyModuleLifecycle().module),
    ...(params.loadOverrideModule ? { loadOverrideModule: params.loadOverrideModule } : {}),
    startExportNames: params.startExportNames,
    ...(params.stopExportNames ? { stopExportNames: params.stopExportNames } : {}),
  });
}

describe("startLazyPluginServiceModule", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_LAZY_SERVICE_SKIP;
    delete process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE;
  });

  it("starts the default module and returns its stop hook", async () => {
    const lifecycle = createLazyModuleLifecycle();

    const handle = await expectLifecycleStarted({
      loadDefaultModule: async () => lifecycle.module,
      startExportNames: ["startDefault"],
      stopExportNames: ["stopDefault"],
    });

    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(handle).not.toBeNull();
    await handle?.stop();
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  });

  it("honors skip env before loading the module", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_SKIP = "1";
    const loadDefaultModule = vi.fn(async () => createLazyModuleLifecycle().module);

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
    const start = createAsyncHookMock();
    const loadOverrideModule = vi.fn(async () => ({ startOverride: start }));

    await expectLifecycleStarted({
      overrideEnvVar: "OPENCLAW_LAZY_SERVICE_OVERRIDE",
      loadDefaultModule: async () => ({ startDefault: createAsyncHookMock() }),
      loadOverrideModule,
      startExportNames: ["startOverride", "startDefault"],
    });

    expect(loadOverrideModule).toHaveBeenCalledWith("virtual:service");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("validates the override specifier before loading it", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE = "virtual:service";
    const loadOverrideModule = vi.fn(async () => ({ startOverride: createAsyncHookMock() }));
    const validateOverrideSpecifier = vi.fn((specifier: string) => `validated:${specifier}`);

    await expectLifecycleStarted({
      overrideEnvVar: "OPENCLAW_LAZY_SERVICE_OVERRIDE",
      validateOverrideSpecifier,
      loadOverrideModule,
      startExportNames: ["startOverride"],
    });

    expect(validateOverrideSpecifier).toHaveBeenCalledWith("virtual:service");
    expect(loadOverrideModule).toHaveBeenCalledWith("validated:virtual:service");
  });

  it("surfaces override validation failures", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE = "data:text/javascript,boom";

    await expect(
      expectLifecycleStarted({
        overrideEnvVar: "OPENCLAW_LAZY_SERVICE_OVERRIDE",
        validateOverrideSpecifier: () => {
          throw new Error("blocked override");
        },
        startExportNames: ["startDefault"],
      }),
    ).rejects.toThrow("blocked override");
  });
});

describe("defaultLoadOverrideModule", () => {
  it("passes the specifier through unchanged on non-win32 platforms", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      const importer = vi.fn(async () => ({ startDefault: async () => {} }));
      await defaultLoadOverrideModule("/home/alice/plugin/index.mjs", importer);
      expect(importer).toHaveBeenCalledWith("/home/alice/plugin/index.mjs");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("normalizes a Windows drive-letter path to a file:// URL before importing", async () => {
    // Regression test for openclaw/openclaw#72573: on Windows, dynamic
    // import() of a bare "C:\\..." specifier throws
    // ERR_UNSUPPORTED_ESM_URL_SCHEME because the loader treats the drive
    // letter as an unknown URL scheme. The default loader must convert such
    // paths through toSafeImportPath before handing them to import().
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const importer = vi.fn(async () => ({ startDefault: async () => {} }));
      await defaultLoadOverrideModule(
        "C:\\Users\\alice\\plugin\\index.mjs",
        importer,
      );
      expect(importer).toHaveBeenCalledWith(
        "file:///C:/Users/alice/plugin/index.mjs",
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("leaves an existing file:// URL untouched on win32", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const importer = vi.fn(async () => ({ startDefault: async () => {} }));
      await defaultLoadOverrideModule(
        "file:///C:/Users/alice/plugin/index.mjs",
        importer,
      );
      expect(importer).toHaveBeenCalledWith(
        "file:///C:/Users/alice/plugin/index.mjs",
      );
    } finally {
      platformSpy.mockRestore();
    }
  });
});
