import { describe, expect, it } from "vitest";
import {
  normalizeConfigPath,
  normalizeConfigPaths,
} from "../../test/helpers/vitest-config-paths.js";
import { BUNDLED_PLUGIN_E2E_TEST_GLOB } from "../../test/vitest/vitest.bundled-plugin-paths.ts";
import e2eConfig, { resolveE2EWorkerCount } from "../../test/vitest/vitest.e2e.config.ts";

describe("e2e vitest config", () => {
  it("runs as a standalone config instead of inheriting unit projects", () => {
    expect(e2eConfig.test?.projects).toBeUndefined();
  });

  it("includes e2e test globs and runtime setup", () => {
    expect(e2eConfig.test?.include).toEqual([
      "test/**/*.e2e.test.ts",
      "src/**/*.e2e.test.ts",
      "packages/**/*.e2e.test.ts",
      "src/gateway/gateway.test.ts",
      "src/gateway/server.startup-matrix-migration.integration.test.ts",
      "src/gateway/sessions-history-http.test.ts",
      BUNDLED_PLUGIN_E2E_TEST_GLOB,
    ]);
    expect(e2eConfig.test?.pool).toBe("threads");
    expect(e2eConfig.test?.isolate).toBe(false);
    expect(normalizeConfigPath(e2eConfig.test?.runner)).toBe("test/non-isolated-runner.ts");
    expect(normalizeConfigPaths(e2eConfig.test?.setupFiles)).toContain(
      "test/setup-openclaw-runtime.ts",
    );
  });

  it("serializes default e2e runs while preserving explicit worker overrides", () => {
    expect(e2eConfig.test?.maxWorkers).toBe(1);
    expect(resolveE2EWorkerCount({})).toBe(1);
    expect(resolveE2EWorkerCount({ OPENCLAW_E2E_WORKERS: "4" })).toBe(4);
    expect(resolveE2EWorkerCount({ OPENCLAW_E2E_WORKERS: "99" })).toBe(16);
    expect(resolveE2EWorkerCount({ OPENCLAW_E2E_WORKERS: "0" })).toBe(1);
  });
});
