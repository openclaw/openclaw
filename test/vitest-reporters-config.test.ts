import { expect, it } from "vitest";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "./vitest/vitest.timeouts.ts";

const reporterConfigs = [
  "vitest.config.ts",
  ...`tooling cli-process unit-fast gateway-server-isolated ui ui-browser ui-e2e e2e`
    .split(" ")
    .map((name) => `test/vitest/vitest.${name}.config.ts`),
  "ui/vitest.config.ts",
  "ui/vitest.node.config.ts",
];

it.each(["false", "true"])(
  "redacts every reporter selection and preserves overrides with GITHUB_ACTIONS=%s",
  (githubActions) => {
    // Configs capture their environment on import; assert in that same fresh process.
    const result = spawnNodeEvalSync(
      `import assert from "node:assert/strict";
          import path from "node:path";
          import { pathToFileURL } from "node:url";
          import { parseCLI, resolveConfig } from "vitest/node";
          import { sharedVitestConfig } from "./test/vitest/vitest.shared.config.ts";
          import { createTuiPtyVitestConfig } from "./test/vitest/vitest.tui-pty.config.ts";
          const resolve = (config, options = {}) => resolveConfig({ ...options, config: false }, config);
          const named = names => names.map(name => [name, {}]);
          async function check(config, reporters, options = {}) {
            const actual = (await resolve(config, options)).test.reporters;
            assert.deepEqual(actual, [[path.resolve("test/vitest/redacting-reporter.ts"), { reporters }]]);
          }
          const expected = ${githubActions === "true" ? '["verbose", "github-actions"]' : '["verbose"]'};
          for (const config of ${JSON.stringify(reporterConfigs)}) {
            const root = config.startsWith("ui/") ? path.resolve("ui") : process.cwd();
            const imported = (await import(pathToFileURL(path.resolve(config)).href)).default;
            const reporterConfig = { ...imported, test: { ...imported.test } };
            // The project-config suite owns full root graph resolution.
            if (config === "vitest.config.ts") delete reporterConfig.test.projects;
            const names = config === "test/vitest/vitest.ui-browser.config.ts"
              ? ["minimal", ...expected.slice(1)]
              : ["tooling", "ui-e2e", "e2e"].some(name => config === "test/vitest/vitest." + name + ".config.ts")
                ? [...expected, "default"] : expected;
            await check(reporterConfig, named(names), { root });
            await check(reporterConfig, named(["json"]), { ...parseCLI(["vitest", "--reporter=json"]).options, root });
          }
          const customReporters = [["json", { outputFile: "custom-report.json" }],
            [path.resolve("scripts/lib/vitest-resource-reporter.mts"), { proof: "custom options" }]];
          const customConfig = { ...sharedVitestConfig, test: { ...sharedVitestConfig.test, reporters: customReporters } };
          await check(customConfig, customReporters);
          await check(customConfig, customReporters, parseCLI([
            "vitest", "--reporter=json", "--reporter=json",
            "--reporter=./scripts/lib/vitest-resource-reporter.mts",
            "--reporter=./scripts/lib/vitest-resource-reporter.mts",
          ]).options);
          await check(createTuiPtyVitestConfig({
            GITHUB_ACTIONS: process.env.GITHUB_ACTIONS === "true" ? "false" : "true",
          }), named(${githubActions === "true" ? '["verbose"]' : '["verbose", "github-actions"]'}));
          await assert.rejects(() => resolve(customConfig, { mergeReports: "synthetic-blobs", reporter: ["blob"] }), {
            message: ${JSON.stringify("Cannot merge reports when `--reporter=blob` is used. Remove blob reporter from the config first.")},
          });`,
      {
        imports: ["tsx"],
        env: {
          ...process.env,
          AI_AGENT: "vitest-reporter-test",
          GITHUB_ACTIONS: githubActions,
          OPENCLAW_VITEST_INCLUDE_FILE: undefined,
        },
        timeout: DEFAULT_VITEST_TEST_TIMEOUT_MS,
      },
    );
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result, result.stdout + result.stderr).toMatchObject({ signal: null, status: 0 });
  },
);
