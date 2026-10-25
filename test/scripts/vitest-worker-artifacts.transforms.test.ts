import fs from "node:fs";
import path from "node:path";
import { describe, expect } from "vitest";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";
import {
  createControlledWorkerCompiler,
  createWorkerArtifactTest,
  inWorkerArtifactFixture,
  readFixtureLines,
} from "./vitest-worker-artifacts.test-support.js";
import { workerTransformProbe } from "./vitest-worker-artifacts.transforms.test-support.js";

const root = process.cwd();
const it = createWorkerArtifactTest();

// Each sequence owns its cache and two generations; keep their observations ordered.
describe("fresh compiled subprocess invocation", { concurrent: false }, () => {
  it.for((["single", "projects"] as const).map((layout) => ({ layout })))(
    "preserves filesystem transforms across fresh generations, source mode, and edits ($layout)",
    ({ layout }, { workerArtifacts, signal, onTestFinished }) =>
      inWorkerArtifactFixture(
        { workerArtifacts, signal, onTestFinished },
        async ({ runtime, startBorrower, directory }) => {
          const { config, value, configuredValue, parent } = workerTransformProbe(
            directory,
            layout,
          );
          const projectNames = layout === "projects" ? ["first", "second"] : ["first"];
          const projectCount = projectNames.length;
          const controlled = createControlledWorkerCompiler(
            directory,
            testRunnerFixtureEnv(),
            process.versions.bun ? "bun" : "node",
          );
          const readJsonLines = <T>(name: string) =>
            readFixtureLines<T>(path.join(directory, name));
          const counts = () => {
            const transformed = readJsonLines<string>("transforms.jsonl").map(path.normalize);
            return [[value, configuredValue], [parent]].map(
              (ids) => transformed.filter((actual) => ids.includes(actual)).length,
            );
          };
          let compiled = false;
          const owner = createVitestWorkerRun(controlled.env);
          let redirectedCompilers = 0;
          // The second owner lives in this process; its child env cannot intercept its spawn.
          const compilerLaunch = controlled.intercept(owner.descriptor.directory, () => {
            redirectedCompilers += 1;
          });
          try {
            const launch = async (
              mode: "compiled" | "source",
              transforms: number[],
              expectedValue = "first",
            ) => {
              const args = [
                "run",
                "--config",
                config,
                ...projectNames.flatMap((name) => ["--project", name]),
              ];
              const previousObservations = fs.existsSync(path.join(directory, "observations.jsonl"))
                ? readJsonLines("observations.jsonl").length
                : 0;
              const reuse = mode === "compiled" && compiled;
              const result = reuse
                ? await startBorrower(owner, args).result
                : await runtime(
                    [
                      mode === "compiled"
                        ? process.versions.bun
                          ? "scripts/run-vitest-child.mts"
                          : "scripts/run-vitest.mjs"
                        : "node_modules/vitest/vitest.mjs",
                      ...args,
                    ],
                    root,
                    controlled.env,
                  );
              expect(result.code, result.stderr + result.stdout).toBe(0);
              const observed = readJsonLines("observations.jsonl").slice(previousObservations);
              expect(observed).toEqual(
                projectNames.map(() => ({ value: expectedValue, configValue: "first" })),
              );
              compiled ||= mode === "compiled";
              expect(counts(), "filesystem transform reuse").toEqual(
                transforms.map((count) => count * projectCount),
              );
            };
            await launch("compiled", [1, 1]);
            await launch("compiled", [1, 1]);
            await launch("source", [2, 2]);
            fs.writeFileSync(value, 'export const value: string = "second";');
            await launch("compiled", [3, 2], "second");
            fs.writeFileSync(
              config,
              fs
                .readFileSync(config, "utf8")
                .replace(
                  `replacement:${JSON.stringify(value)}`,
                  `replacement:${JSON.stringify(configuredValue)}`,
                ),
            );
            await launch("compiled", [4, 3], "configured");
            expect(redirectedCompilers).toBe(1);
          } finally {
            try {
              await owner.dispose();
            } finally {
              compilerLaunch.mockRestore();
            }
          }
        },
      ),
  );
});
