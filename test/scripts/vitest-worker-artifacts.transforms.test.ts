import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, vi } from "vitest";
import * as managedChild from "../../scripts/lib/managed-child-process.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import {
  createControlledWorkerCompiler,
  createWorkerArtifactTest,
} from "./vitest-worker-artifacts.test-support.js";
import { workerTransformProbe } from "./vitest-worker-artifacts.transforms.test-support.js";

const root = process.cwd();
const it = createWorkerArtifactTest();

function readCompilerEvidence(filename: string) {
  try {
    return {
      contents: fs
        .readFileSync(filename, "utf8")
        .replaceAll(JSON.stringify(root).slice(1, -1), "<checkout>"),
    };
  } catch (error) {
    return { readError: (error as NodeJS.ErrnoException).code ?? "unreadable" };
  }
}

// Each sequence owns its cache and two generations; keep their observations ordered.
// Full SQLite/archive/TUI/setup/KNN execution stays in worker-artifacts source/borrower tests.
describe("fresh compiled subprocess invocation", { concurrent: false }, () => {
  it("keeps one lifetime identity when the fixture compiler runs twice in one process", ({
    workerArtifacts,
  }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const { runtime } = workerArtifacts.createFixtureCommands();
      const directory = workerArtifacts.fixtureDirectory();
      const controlled = createControlledWorkerCompiler(directory, process.env);
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
        const controlled = createControlledWorkerCompiler(
          directory,
          process.env,
          process.versions.bun ? "bun" : "node",
        );
        const readLines = (name: string) =>
          fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n");
        const counts = () => {
          const transformed = readLines("transforms.jsonl").map((line) =>
            path.normalize(JSON.parse(line)),
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
            expectedValue = "first",
            configValue = "first",
          ) => {
            const args = ["run", "--config", config, "--project", "first"];
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
            if (result.code !== 0) {
              // Read the fixture's existing evidence before its assertion unwinds cleanup.
              // The inner owner may already have removed a joined compiler's generation.
              const manifests = (() => {
                try {
                  return controlled.read().map(({ directory: generation, ...receipt }) => ({
                    ...receipt,
                    generation: path.basename(generation),
                    manifest:
                      path.dirname(generation) === path.join(root, ".artifacts", "vitest-workers")
                        ? readCompilerEvidence(path.join(generation, "manifest.json"))
                        : { readError: "outside-worker-root" },
                  }));
                } catch (error) {
                  return { readError: (error as NodeJS.ErrnoException).code ?? "invalid-receipt" };
                }
              })();
              console.error(
                "Controlled compiler failure context",
                JSON.stringify({
                  layout,
                  mode,
                  reuse,
                  code: result.code,
                  runtime: {
                    executable: path.basename(process.execPath),
                    version: process.version,
                    uv: process.versions.uv,
                  },
                  receipts: readCompilerEvidence(path.join(directory, "fixture-compilers.jsonl")),
                  manifests,
                }),
              );
            }
            expect(result.code, result.stderr + result.stdout).toBe(0);
            const generation: string = JSON.parse(readLines("generations.jsonl").at(-1)!);
            const observed = JSON.parse(readLines("observations.jsonl").at(-1)!);
            expect(observed.value).toBe(expectedValue);
            expect(observed.configValue).toBe(configValue);
            if (mode === "compiled") {
              const generationDirectory = fileURLToPath(new URL("../../", generation));
              if (reuse) {
                expect(result.stderr).not.toContain("[vitest-workers] prepared");
                expect(path.resolve(generationDirectory)).toBe(owner.descriptor.directory);
              } else {
                expect(result.stderr.match(/\[vitest-workers\] prepared/g)).toHaveLength(1);
              }
              generations.add(generation);
              expect(path.dirname(generationDirectory)).toBe(
                path.join(root, ".artifacts", "vitest-workers"),
              );
              expect(fileURLToPath(generation)).toBe(
                path.join(generationDirectory, "dist/infra/runtime-process-entrypoints.js"),
              );
              // The direct invocation disposes immediately; shared borrowers retain
              // their owner's unchanged generation until the whole sequence finishes.
              expect(fs.existsSync(generationDirectory)).toBe(reuse);
            } else {
              expect(result.stderr).not.toContain("[vitest-workers] prepared");
              expect(fileURLToPath(generation)).toBe(
                path.join(root, "src/infra/runtime-process-entrypoints.ts"),
              );
            }
            console.log(
              "cache transport",
              JSON.stringify({ mode, ...observed, generation, transforms: counts() }),
            );
          };
          await launch("compiled");
          expect(counts()).toEqual([1, 1]);
          expect(
            JSON.parse(fs.readFileSync(path.join(cacheDirectory, "_metadata.json"), "utf8")),
          ).toEqual({ lockfileHash: expect.stringMatching(/^[a-f\d]{8}$/u) });
          await launch("compiled");
          expect(generations.size).toBe(2);
          expect(counts(), "unchanged parents must reuse filesystem transforms").toEqual([1, 1]);
          await launch("source");
          expect(counts()).toEqual([2, 2]);
          // Switching back with a leaf edit also proves the unchanged parent reuses
          // its compiled transform, without preparing another complete worker set.
          fs.writeFileSync(value, 'export const value: string = "second";');
          await launch("compiled", "second");
          expect(counts()).toEqual([3, 2]);
          fs.writeFileSync(
            config,
            fs
              .readFileSync(config, "utf8")
              .replace(
                `replacement:${JSON.stringify(value)}`,
                `replacement:${JSON.stringify(configuredValue)}`,
              ),
          );
          await launch("compiled", "configured");
          expect(counts()).toEqual([4, 3]);
          expect(generations.size).toBe(2);
          expect(
            preparationLog.mock.calls.filter(([line]) =>
              String(line).startsWith("[vitest-workers] prepared"),
            ),
          ).toHaveLength(1);
          const compilers = controlled.read();
          console.log("Controlled compiler receipts", JSON.stringify(compilers));
          expect(redirectedCompilers).toBe(1);
          expect(compilers).toHaveLength(2);
          // Windows can recycle a PID after exit; process start distinguishes its next owner.
          expect(
            new Set(compilers.map(({ pid, processStartTime }) => `${pid}:${processStartTime}`))
              .size,
          ).toBe(2);
          expect(new Set(compilers.map(({ directory }) => path.resolve(directory)))).toEqual(
            new Set(
              [...generations].map((generation) =>
                path.resolve(fileURLToPath(new URL("../../", generation))),
              ),
            ),
          );
          for (const compiler of compilers) {
            expect(compiler).toMatchObject({
              inputs: 2,
              outputs: 2,
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
