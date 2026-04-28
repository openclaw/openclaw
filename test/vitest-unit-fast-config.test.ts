import { describe, expect, it } from "vitest";
import { createCommandsLightVitestConfig } from "./vitest/vitest.commands-light.config.ts";
import { createPluginSdkLightVitestConfig } from "./vitest/vitest.plugin-sdk-light.config.ts";
import {
  alwaysExcludedUnitFastTestFiles,
  classifyUnitFastTestFileContent,
  collectBroadUnitFastTestCandidates,
  collectUnitFastTestCandidates,
  collectUnitFastTestFileAnalysis,
  forcedUnitFastTestFiles,
  getUnitFastTestFiles,
  isUnitFastTestFile,
  resolveUnitFastTestIncludePattern,
} from "./vitest/vitest.unit-fast-paths.mjs";
import { createUnitFastVitestConfig } from "./vitest/vitest.unit-fast.config.ts";

describe("unit-fast vitest lane", () => {
  it("runs cache-friendly tests without the reset-heavy runner or runtime setup", () => {
    const config = createUnitFastVitestConfig({});

    expect(config.test?.isolate).toBe(false);
    expect(config.test?.runner).toBeUndefined();
    expect(config.test?.setupFiles).toEqual([]);
    expect(config.test?.include).toContain(
      "src/agents/pi-tools.deferred-followup-guidance.test.ts",
    );
    expect(config.test?.include).toContain("src/commands/status-overview-values.test.ts");
    expect(config.test?.include).toContain("src/plugins/config-policy.test.ts");
    expect(config.test?.include).toContain("src/plugin-sdk/provider-entry.test.ts");
  });

  it("does not treat moved config paths as CLI include filters", () => {
    const config = createUnitFastVitestConfig(
      {},
      {
        argv: ["node", "vitest", "run", "--config", "test/vitest/vitest.unit-fast.config.ts"],
      },
    );

    expect(config.test?.include).toContain("src/plugin-sdk/provider-entry.test.ts");
    expect(config.test?.include).toContain("src/commands/status-overview-values.test.ts");
  });

  it("keeps obvious stateful files out of the unit-fast lane", () => {
    expect(isUnitFastTestFile("src/plugin-sdk/temp-path.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/agents/sandbox.resolveSandboxContext.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/crestodian/assistant.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/proxy-capture/coverage.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/secrets/runtime.test.ts")).toBe(false);
    expect(resolveUnitFastTestIncludePattern("src/plugin-sdk/temp-path.ts")).toBeNull();
    expect(classifyUnitFastTestFileContent("vi.resetModules(); await import('./x.js')")).toEqual([
      "module-mocking",
      "vitest-mock-api",
      "dynamic-import",
    ]);
  });

  it("routes unit-fast source files to their unit-fast sibling tests", () => {
    expect(resolveUnitFastTestIncludePattern("src/plugin-sdk/provider-entry.ts")).toBe(
      "src/plugin-sdk/provider-entry.test.ts",
    );
    expect(resolveUnitFastTestIncludePattern("src/commands/status-overview-values.ts")).toBe(
      "src/commands/status-overview-values.test.ts",
    );
  });

  it("routes audited stateful-looking tests through the fast lane", () => {
    const analysis = collectUnitFastTestFileAnalysis();
    const excludedSet = new Set(alwaysExcludedUnitFastTestFiles);
    const expectedForcedUnitFast = forcedUnitFastTestFiles.filter((file) => !excludedSet.has(file));
    const forcedAnalysis = analysis.filter((entry) => expectedForcedUnitFast.includes(entry.file));
    const unitFastTestFiles = getUnitFastTestFiles();

    expect(forcedAnalysis).toHaveLength(expectedForcedUnitFast.length);
    for (const file of expectedForcedUnitFast) {
      expect(unitFastTestFiles).toContain(file);
      expect(isUnitFastTestFile(file)).toBe(true);
    }
    expect(forcedAnalysis.every((entry) => entry.forced && entry.unitFast)).toBe(true);
    for (const file of alwaysExcludedUnitFastTestFiles) {
      expect(isUnitFastTestFile(file)).toBe(false);
    }
  });

  it("keeps broad audit candidates separate from automatically routed unit-fast tests", () => {
    const currentCandidates = collectUnitFastTestCandidates();
    const broadCandidates = collectBroadUnitFastTestCandidates();
    const broadAnalysis = collectUnitFastTestFileAnalysis(process.cwd(), { scope: "broad" });
    const unitFastTestFiles = getUnitFastTestFiles();

    expect(currentCandidates.length).toBeGreaterThanOrEqual(unitFastTestFiles.length);
    expect(broadCandidates.length).toBeGreaterThan(currentCandidates.length);
    expect(broadAnalysis.filter((entry) => entry.unitFast).length).toBeGreaterThan(
      unitFastTestFiles.length,
    );
  });

  it("excludes unit-fast files from the older light lanes so full runs do not duplicate them", () => {
    const pluginSdkLight = createPluginSdkLightVitestConfig({});
    const commandsLight = createCommandsLightVitestConfig({});
    const unitFastTestFiles = getUnitFastTestFiles();

    expect(unitFastTestFiles).toContain("src/plugin-sdk/provider-entry.test.ts");
    expect(pluginSdkLight.test?.exclude).toContain("plugin-sdk/provider-entry.test.ts");
    expect(commandsLight.test?.exclude).toContain("status-overview-values.test.ts");
  });
});
