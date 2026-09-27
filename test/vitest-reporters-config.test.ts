import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "./vitest/vitest.timeouts.ts";

const reporterConfigs = [
  "vitest.config.ts",
  "test/vitest/vitest.tooling.config.ts",
  "test/vitest/vitest.cli-process.config.ts",
  "test/vitest/vitest.unit-fast.config.ts",
  "test/vitest/vitest.gateway-server-isolated.config.ts",
  "test/vitest/vitest.ui.config.ts",
  "test/vitest/vitest.ui-browser.config.ts",
  "test/vitest/vitest.ui-e2e.config.ts",
  "test/vitest/vitest.e2e.config.ts",
  "ui/vitest.config.ts",
  "ui/vitest.node.config.ts",
];

type ReporterEntry = [string, Record<string, unknown>];
type ReporterResolution = {
  defaults: Array<{ config: string; reporters: ReporterEntry[]; cli: ReporterEntry[] }>;
  custom: ReporterEntry[];
  customCli: ReporterEntry[];
  injectedPty: ReporterEntry[];
  blobMergeError: string | undefined;
};

const redactingReporterPath = fileURLToPath(
  new URL("./vitest/redacting-reporter.ts", import.meta.url),
);
const customReporterPath = path.resolve("scripts/lib/vitest-resource-reporter.mts");

function wrappedReporters(reporters: ReporterEntry[]): ReporterEntry[] {
  return [[redactingReporterPath, { reporters }]];
}

describe("Vitest reporter contracts", () => {
  it.each(["false", "true"])(
    "redacts every reporter selection and preserves overrides with GITHUB_ACTIONS=%s",
    (githubActions) => {
      // Resolve imported configs in a fresh process: shared config and std-env
      // capture their environment on import.
      const result = spawnNodeEvalSync(
        `
          import path from "node:path";
          import { pathToFileURL } from "node:url";
          import { parseCLI, resolveConfig } from "vitest/node";
          import { sharedVitestConfig } from "./test/vitest/vitest.shared.config.ts";
          import { createTuiPtyVitestConfig } from "./test/vitest/vitest.tui-pty.config.ts";
          const defaults = [];
          for (const config of ${JSON.stringify(reporterConfigs)}) {
            const root = config.startsWith("ui/") ? path.resolve("ui") : process.cwd();
            const imported = (await import(pathToFileURL(path.resolve(config)).href)).default;
            const options = { root, config: false };
            let reporterConfig = imported;
            if (config === "vitest.config.ts") {
              // The project-config suite owns full root graph resolution.
              reporterConfig = { ...imported, test: { ...imported.test } };
              delete reporterConfig.test.projects;
            }
            const normal = await resolveConfig(options, reporterConfig);
            const cli = parseCLI(["vitest", "--reporter=json"]).options;
            const override = await resolveConfig({ ...cli, ...options }, reporterConfig);
            defaults.push({ config, reporters: normal.test.reporters, cli: override.test.reporters });
          }
          const customConfig = {
            ...sharedVitestConfig,
            test: {
              ...sharedVitestConfig.test,
              reporters: [
                ["json", { outputFile: "custom-report.json" }],
                [${JSON.stringify(customReporterPath)}, { proof: "custom options" }],
              ],
            },
          };
          const custom = await resolveConfig({ config: false }, customConfig);
          const customCli = await resolveConfig({
            ...parseCLI([
              "vitest", "--reporter=json", "--reporter=json",
              "--reporter=./scripts/lib/vitest-resource-reporter.mts",
              "--reporter=./scripts/lib/vitest-resource-reporter.mts",
            ]).options,
            config: false,
          }, customConfig);
          const injectedPty = await resolveConfig({ config: false }, createTuiPtyVitestConfig({
            GITHUB_ACTIONS: process.env.GITHUB_ACTIONS === "true" ? "false" : "true",
          }));
          let blobMergeError;
          try {
            await resolveConfig({
              config: false, mergeReports: "synthetic-blobs", reporter: ["blob"],
            }, customConfig);
          } catch (error) {
            blobMergeError = error instanceof Error ? error.message : String(error);
          }
          console.log("REPORTER_RESOLUTION " + JSON.stringify({
            defaults,
            custom: custom.test.reporters,
            customCli: customCli.test.reporters,
            injectedPty: injectedPty.test.reporters,
            blobMergeError,
          }));
        `,
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
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      const report = result.stdout
        .split("\n")
        .find((line) => line.startsWith("REPORTER_RESOLUTION "));
      expect(report, result.stdout).toBeDefined();
      const resolved = JSON.parse(
        report!.slice("REPORTER_RESOLUTION ".length),
      ) as ReporterResolution;
      const expected = githubActions === "true" ? ["verbose", "github-actions"] : ["verbose"];
      for (const { config, reporters, cli } of resolved.defaults) {
        const names =
          config === "test/vitest/vitest.ui-browser.config.ts"
            ? ["minimal", ...expected.slice(1)]
            : [
                  "test/vitest/vitest.tooling.config.ts",
                  "test/vitest/vitest.ui-e2e.config.ts",
                  "test/vitest/vitest.e2e.config.ts",
                ].includes(config)
              ? [...expected, "default"]
              : expected;
        expect(reporters, config).toEqual(wrappedReporters(names.map((name) => [name, {}])));
        expect(cli, `${config} CLI override`).toEqual(wrappedReporters([["json", {}]]));
      }
      expect(resolved.defaults).toHaveLength(reporterConfigs.length);
      expect(resolved.custom).toEqual(
        wrappedReporters([
          ["json", { outputFile: "custom-report.json" }],
          [customReporterPath, { proof: "custom options" }],
        ]),
      );
      expect(resolved.customCli).toEqual(resolved.custom);
      expect(resolved.blobMergeError).toBe(
        "Cannot merge reports when `--reporter=blob` is used. Remove blob reporter from the config first.",
      );
      expect(resolved.injectedPty).toEqual(
        wrappedReporters(
          (githubActions === "true" ? ["verbose"] : ["verbose", "github-actions"]).map((name) => [
            name,
            {},
          ]),
        ),
      );
    },
  );
});
