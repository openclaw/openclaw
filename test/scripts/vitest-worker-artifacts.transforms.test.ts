import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, vi } from "vitest";
import * as managedChild from "../../scripts/lib/managed-child-process.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";
import {
  createControlledWorkerCompiler,
  createWorkerArtifactTest,
} from "./vitest-worker-artifacts.test-support.js";
import { workerTransformProbe } from "./vitest-worker-artifacts.transforms.test-support.js";

const root = process.cwd();
const it = createWorkerArtifactTest();
const generationDirectory = (url: string) => fileURLToPath(new URL("../../", url));

// Each sequence owns its cache and two generations; keep their observations ordered.
describe("fresh compiled subprocess invocation", { concurrent: false }, () => {
  it("keeps one lifetime identity when the fixture compiler runs twice in one process", ({
    workerArtifacts,
  }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const { runtime } = workerArtifacts.createFixtureCommands();
      const directory = workerArtifacts.fixtureDirectory();
      const controlled = createControlledWorkerCompiler(directory, testRunnerFixtureEnv());
      const [compiler, first, input, receipt] = controlled.args(path.join(directory, "first"));
      const result = await runtime([
        "--input-type=module",
        "--eval",
        `import {runWorkerFixtureCompiler} from ${JSON.stringify(pathToFileURL(compiler!).href)};
        await runWorkerFixtureCompiler(${JSON.stringify(first)}, ${JSON.stringify(input)}, ${JSON.stringify(receipt)});
        await runWorkerFixtureCompiler(${JSON.stringify(path.join(directory, "second"))}, ${JSON.stringify(input)}, ${JSON.stringify(receipt)});`,
      ]);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      const compilers = controlled.read();
      expect(compilers).toHaveLength(2);
      expect(compilers[0]!.processStartTime).toBeGreaterThan(0);
      expect(compilers[1]).toMatchObject({
        pid: compilers[0]!.pid,
        processStartTime: compilers[0]!.processStartTime,
      });
    }));

  it.for((["single", "projects"] as const).map((layout) => ({ layout })))(
    "preserves filesystem transforms across fresh generations, source mode, and edits ($layout)",
    ({ layout }, { workerArtifacts }) =>
      workerArtifacts.fixtureLifetime.run(async () => {
        const { runtime, startBorrower } = workerArtifacts.createFixtureCommands();
        const directory = workerArtifacts.fixtureDirectory();
        const { config, value, configuredValue, parent, cacheDirectory } = workerTransformProbe(
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
        const readLines = (name: string) =>
          fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n");
        const readJsonLines = (name: string) => readLines(name).map((line) => JSON.parse(line));
        const counts = () => {
          const transformed = readJsonLines("transforms.jsonl").map((file: string) =>
            path.normalize(file),
          );
          return [[value, configuredValue], [parent]].map(
            (ids) => transformed.filter((actual) => ids.includes(actual)).length,
          );
        };
        const generations = new Set<string>();
        const owner = createVitestWorkerRun(controlled.env);
        const runManaged = managedChild.runManagedCommand;
        let redirectedCompilers = 0;
        // The second owner lives in this process; its child env cannot intercept its spawn.
        const compilerLaunch = vi
          .spyOn(managedChild, "runManagedCommand")
          .mockImplementation((options) => {
            if (
              options.args?.[0] === path.join(root, "scripts/lib/vitest-worker-compiler.mts") &&
              options.args[1] === owner.descriptor.directory
            ) {
              redirectedCompilers += 1;
              return runManaged({ ...options, args: controlled.args(owner.descriptor.directory) });
            }
            return runManaged(options);
          });
        const preparationLog = vi.spyOn(console, "error");
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
              ? readLines("observations.jsonl").length
              : 0;
            const reuse = mode === "compiled" && generations.size > 0;
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
            const currentGenerations: string[] =
              readJsonLines("generations.jsonl").slice(previousObservations);
            const observed = readJsonLines("observations.jsonl").slice(previousObservations);
            expect(observed).toEqual(
              projectNames.map(() => ({ value: expectedValue, configValue: "first" })),
            );
            expect(currentGenerations).toHaveLength(projectCount);
            expect(new Set(currentGenerations).size).toBe(1);
            const generation = currentGenerations[0]!;
            if (mode === "compiled") {
              const dir = generationDirectory(generation);
              if (reuse) {
                expect(result.stderr).not.toContain("[vitest-workers] prepared");
                expect(path.resolve(dir)).toBe(owner.descriptor.directory);
              } else {
                expect(result.stderr.match(/\[vitest-workers\] prepared/g)).toHaveLength(1);
              }
              generations.add(generation);
              expect(path.dirname(dir)).toBe(path.join(root, ".artifacts", "vitest-workers"));
              expect(fileURLToPath(generation)).toBe(
                path.join(dir, "dist/infra/runtime-process-entrypoints.js"),
              );
              expect(fs.existsSync(dir)).toBe(reuse);
            } else {
              expect(result.stderr).not.toContain("[vitest-workers] prepared");
              expect(fileURLToPath(generation)).toBe(
                path.join(root, "src/infra/runtime-process-entrypoints.ts"),
              );
            }
            expect(counts(), "filesystem transform reuse").toEqual(
              transforms.map((count) => count * projectCount),
            );
          };
          await launch("compiled", [1, 1]);
          expect(
            JSON.parse(fs.readFileSync(path.join(cacheDirectory, "_metadata.json"), "utf8")),
          ).toEqual({ lockfileHash: expect.stringMatching(/^[a-f\d]{8}$/u) });
          await launch("compiled", [1, 1]);
          expect(generations.size).toBe(2);
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
          expect(generations.size).toBe(2);
          expect(
            preparationLog.mock.calls.filter(([line]) =>
              String(line).startsWith("[vitest-workers] prepared"),
            ),
          ).toHaveLength(1);
          const compilers = controlled.read();
          expect(redirectedCompilers).toBe(1);
          expect(compilers).toHaveLength(2);
          // Windows can recycle a PID after exit; process start distinguishes its next owner.
          expect(
            new Set(compilers.map(({ pid, processStartTime }) => `${pid}:${processStartTime}`))
              .size,
          ).toBe(2);
          expect(
            new Set(compilers.map(({ directory: generation }) => path.resolve(generation))),
          ).toEqual(new Set([...generations].map((url) => path.resolve(generationDirectory(url)))));
          for (const compiler of compilers) {
            expect(compiler).toMatchObject({
              inputs: 3,
              outputs: 3,
              processStartTime: expect.any(Number),
              isMainThread: true,
            });
          }
        } finally {
          try {
            await owner.dispose();
          } finally {
            compilerLaunch.mockRestore();
            preparationLog.mockRestore();
          }
        }
        for (const generation of generations) {
          expect(fs.existsSync(new URL("../../", generation))).toBe(false);
        }
      }),
  );
});
