import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, vi } from "vitest";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createWorkerArtifactTest, workerProbe } from "./vitest-worker-artifacts.test-support.js";

const root = process.cwd();
const it = createWorkerArtifactTest();
// Each sequence rebuilds all workers; avoid competing builds within one runner.
describe("fresh compiled subprocess invocation", { concurrent: false }, () => {
  it.for((["single", "projects"] as const).map((layout) => ({ layout })))(
    "preserves filesystem transforms across fresh generations, source mode, and edits ($layout)",
    ({ layout }, { workerArtifacts }) =>
      workerArtifacts.fixtureLifetime.run(async () => {
        const { node, startBorrower } = workerArtifacts.createFixtureCommands();
        const directory = workerArtifacts.fixtureDirectory();
        const { config, value, configuredValue, parent, cacheDirectory } = workerProbe(
          directory,
          false,
          "auto",
          layout,
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
        const owner = createVitestWorkerRun();
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
              : await node([
                  mode === "compiled" ? "scripts/run-vitest.mjs" : "node_modules/vitest/vitest.mjs",
                  ...args,
                ]);
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
                path.join(generationDirectory, "dist/infra/sqlite-readonly-location.worker.js"),
              );
              expect(observed.args[0]).toBe(
                path.join(generationDirectory, "dist/infra/sqlite-readonly-location.worker.js"),
              );
              expect(fileURLToPath(observed.knn)).toBe(
                path.join(
                  generationDirectory,
                  "dist/extensions/memory-core/memory-search-knn.child.js",
                ),
              );
              // The direct invocation disposes immediately; shared borrowers retain
              // their owner's unchanged generation until the whole sequence finishes.
              expect(fs.existsSync(generationDirectory)).toBe(reuse);
            } else {
              expect(result.stderr).not.toContain("[vitest-workers] prepared");
              expect(fileURLToPath(generation)).toBe(
                path.join(root, "src/infra/sqlite-readonly-location.worker.ts"),
              );
              expect(observed.args[0]).toBe("--import");
              expect(observed.args[1]).toMatch(/^file:\/\//);
              expect(fileURLToPath(observed.knn)).toBe(
                path.join(root, "extensions/memory-core/src/memory/manager-search-knn.child.ts"),
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
        } finally {
          preparationLog.mockRestore();
          await owner.dispose();
        }
        for (const generation of generations) {
          expect(fs.existsSync(new URL("../../", generation))).toBe(false);
        }
      }),
  );
});
