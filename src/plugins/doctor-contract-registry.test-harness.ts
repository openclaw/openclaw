import path from "node:path";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const state = vi.hoisted(() => ({ legacySetup: false, warn: vi.fn() }));

vi.mock("./plugin-instance-module-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-instance-module-loader.js")>();
  const { getCachedPluginModuleLoader } = await import("./plugin-module-loader-cache.js");
  return {
    ...actual,
    bindPluginInstanceModuleLoader: (
      params: Parameters<typeof actual.bindPluginInstanceModuleLoader>[0],
    ) => {
      if (state.legacySetup && !/^(?:doctor-)?contract-api\./.test(path.basename(params.source))) {
        return actual.bindPluginInstanceModuleLoader(params);
      }
      params.instance.bindModuleLoader(
        getCachedPluginModuleLoader({
          modulePath: params.source,
          importerUrl: import.meta.url,
          createLoader: getRegistryJitiMocks().createJiti,
        }),
      );
    },
  };
});

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: state.warn,
    }),
  };
});

export function useDoctorContractRegistryHarness(
  options: {
    legacySetup?: boolean;
    waitForRetirement?: boolean;
    reset?: () => void;
  } = {},
) {
  state.legacySetup = options.legacySetup ?? false;
  const tempDirs: string[] = [];
  let registry: typeof import("./doctor-contract-registry.js");
  let clearCache: typeof import("./doctor-contract-registry.test-fixtures.js").clearPluginDoctorContractRegistryCache;
  let waitForRetirement:
    | typeof import("./plugin-cache.js").waitForPluginCacheRetirement
    | undefined;

  beforeAll(async () => {
    vi.resetModules();
    registry = await import("./doctor-contract-registry.js");
    ({ clearPluginDoctorContractRegistryCache: clearCache } =
      await import("./doctor-contract-registry.test-fixtures.js"));
    if (options.waitForRetirement) {
      ({ waitForPluginCacheRetirement: waitForRetirement } = await import("./plugin-cache.js"));
    }
  });
  beforeEach(() => {
    resetRegistryJitiMocks();
    state.warn.mockReset();
    options.reset?.();
    clearCache();
  });
  if (options.waitForRetirement) {
    afterEach(async () => {
      clearCache?.();
      try {
        await waitForRetirement?.();
      } finally {
        cleanupTrackedTempDirs(tempDirs);
      }
    });
  } else {
    afterEach(() => {
      clearCache?.();
      cleanupTrackedTempDirs(tempDirs);
    });
  }
  return {
    mocks: getRegistryJitiMocks(),
    warn: state.warn,
    makeTempDir: () => makeTrackedTempDir("openclaw-doctor-contract-registry", tempDirs),
    get registry() {
      return registry;
    },
    get clearCache() {
      return clearCache;
    },
  };
}
