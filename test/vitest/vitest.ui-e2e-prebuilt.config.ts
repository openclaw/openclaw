import {
  defineConfig,
  type TestProjectInlineConfiguration,
  type TestUserConfig,
} from "vitest/config";
import { intersectIncludePatterns } from "./vitest.include-patterns.ts";
import { matchesVitestGlob } from "./vitest.pattern-file.ts";
import { createUiE2eVitestConfig } from "./vitest.ui-e2e.config.ts";
import { uiE2ePrebuiltParallelTestFiles, uiE2eRealGatewayTestFiles } from "./vitest.ui-paths.mjs";

const parallelFiles = new Set(uiE2ePrebuiltParallelTestFiles);

export function createPrebuiltUiE2eVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  const base = createUiE2eVitestConfig(env, argv);
  const include =
    intersectIncludePatterns(
      uiE2eRealGatewayTestFiles,
      base.test?.include ?? [],
      matchesVitestGlob,
    ) ?? [];
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
      intersectIncludePatterns(include, template.test.include ?? [], matchesVitestGlob) ?? [];
    const globalSetup = [
      "test/vitest/vitest.ui-e2e-prebuilt.global-setup.ts",
      ...[template.test.globalSetup ?? []].flat(),
    ];
    return [
      {
        ...template,
        test: {
          ...template.test,
          globalSetup,
          include: files.filter((file) => !parallelFiles.has(file)),
        },
      },
      {
        ...template,
        cacheDir: template.cacheDir?.replace("serial", "real-gateway"),
        test: {
          ...template.test,
          globalSetup,
          include: files.filter((file) => parallelFiles.has(file)),
          name: name.replace("serial", "real-gateway"),
          fileParallelism: true,
          // Both later projects share Vitest's one root-bounded worker pool.
          maxWorkers: undefined,
          sequence: { ...template.test.sequence, groupOrder: 2 },
        },
      },
    ];
  });
  return defineConfig({ ...base, test: { ...base.test, include, projects } });
}

export default createPrebuiltUiE2eVitestConfig();
