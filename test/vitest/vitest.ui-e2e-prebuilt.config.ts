import {
  defineConfig,
  type TestProjectInlineConfiguration,
  type TestUserConfig,
} from "vitest/config";
import { intersectIncludePatterns } from "./vitest.include-patterns.ts";
import { matchesNativeVitestGlob } from "./vitest.pattern-file.ts";
import {
  createScopedVitestPatternPlugin,
  scopedVitestPatternPluginName,
} from "./vitest.scoped-patterns.ts";
import {
  createUiE2eVitestConfig,
  resolveUiE2ePatternInventory,
  uiE2ePrivateServerTestFiles,
} from "./vitest.ui-e2e.config.ts";
import { uiE2ePrebuiltParallelTestFiles, uiE2eRealGatewayTestFiles } from "./vitest.ui-paths.mjs";

const parallelFiles = new Set(uiE2ePrebuiltParallelTestFiles);

export function createPrebuiltUiE2eVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  const base = createUiE2eVitestConfig(env, argv);
  const inventory = resolveUiE2ePatternInventory(env);
  const include =
    intersectIncludePatterns(uiE2eRealGatewayTestFiles, inventory.include, matchesNativeVitestGlob)
      ?.include ?? [];
  const project = (name: string) => {
    const selected = base.test?.projects?.find(
      (candidate): candidate is TestProjectInlineConfiguration & { test: TestUserConfig } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "test" in candidate &&
        candidate.test?.name === name,
    );
    if (!selected) {
      throw new Error(`Prebuilt UI E2E requires canonical project ${name}`);
    }
    return selected;
  };
  const projects = ["ui-e2e-serial", "ui-e2e-serial-standalone"].flatMap((name) => {
    const template = project(name);
    const files =
      intersectIncludePatterns(
        include,
        inventory.serialInclude.filter(
          (file) =>
            uiE2ePrivateServerTestFiles.includes(file) === (name === "ui-e2e-serial-standalone"),
        ),
        matchesNativeVitestGlob,
      )?.include ?? [];
    const globalSetup = [
      "test/vitest/vitest.ui-e2e-prebuilt.global-setup.ts",
      ...[template.test.globalSetup ?? []].flat(),
    ];
    const plugins = (owned: string[]) => [
      ...(template.plugins ?? []).filter(
        (plugin) =>
          !(
            plugin &&
            typeof plugin === "object" &&
            "name" in plugin &&
            plugin.name === scopedVitestPatternPluginName
          ),
      ),
      createScopedVitestPatternPlugin(
        owned,
        {
          env,
          argv,
          intersectIncludeFile: true,
          excludeUnitFastTests: false,
        },
        inventory.exclude,
      ),
    ];
    const serial = files.filter((file) => !parallelFiles.has(file));
    const parallel = files.filter((file) => parallelFiles.has(file));
    return [
      {
        ...template,
        plugins: plugins(serial),
        test: {
          ...template.test,
          globalSetup,
        },
      },
      {
        ...template,
        cacheDir: template.cacheDir?.replace("serial", "real-gateway"),
        plugins: plugins(parallel),
        test: {
          ...template.test,
          globalSetup,
          name: name.replace("serial", "real-gateway"),
          fileParallelism: true,
          // Both later projects use the same explicit cap as the root worker pool.
          maxWorkers: base.test?.maxWorkers,
          sequence: { ...template.test.sequence, groupOrder: 2 },
        },
      },
    ];
  });
  return defineConfig({
    ...base,
    plugins: [
      ...(base.plugins ?? []).filter(
        (plugin) =>
          !(
            plugin &&
            typeof plugin === "object" &&
            "name" in plugin &&
            plugin.name === scopedVitestPatternPluginName
          ),
      ),
      createScopedVitestPatternPlugin(
        include,
        {
          env,
          argv,
          intersectIncludeFile: true,
          excludeUnitFastTests: false,
        },
        inventory.exclude,
      ),
    ],
    test: { ...base.test, projects },
  });
}

export default createPrebuiltUiE2eVitestConfig();
