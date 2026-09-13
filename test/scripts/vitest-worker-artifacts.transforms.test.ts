import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { createWorkerArtifactTest } from "./vitest-worker-artifacts.test-support.js";
import { createWorkerTransformsFixture } from "./vitest-worker-transforms-fixture.js";

const it = createWorkerArtifactTest();
// Each sequence owns real compiler processes; avoid competing builds within one runner.
describe("fresh compiled subprocess invocation", { concurrent: false }, () => {
  it.for((["single", "projects"] as const).map((layout) => ({ layout })))(
    "preserves filesystem transforms across fresh generations, source mode, and edits ($layout)",
    ({ layout }, { workerArtifacts }) =>
      workerArtifacts.fixtureLifetime.run(async () => {
        const { node } = workerArtifacts.createFixtureCommands();
        const directory = workerArtifacts.fixtureDirectory();
        const fixture = createWorkerTransformsFixture(directory, layout);
        const { config, value, configuredValue, parent, cacheDirectory, driver } = fixture;
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
        const generations: string[] = [];
        const launch = async (
          mode: "compiled" | "source",
          expectedValue = "first",
          configValue = "first",
        ) => {
          const completion = node(
            [
              mode === "compiled" ? driver : "node_modules/vitest/vitest.mjs",
              "run",
              "--config",
              config,
              "--project",
              "first",
            ],
            directory,
          );
          // A driver can lose an inner owner's cleanup error when it exits.
          // Retain the whole fixture unless success includes its disposal receipt.
          await workerArtifacts.fixtureLifetime.verifyCleanup(async () => {
            const result = await completion;
            expect(result.code, result.stderr + result.stdout).toBe(0);
            if (mode === "compiled") {
              expect(readLines("owners.jsonl")).toHaveLength(generations.length + 1);
            }
          });
          const result = await completion;
          const generation: string = JSON.parse(readLines("generations.jsonl").at(-1)!);
          const observed = JSON.parse(readLines("observations.jsonl").at(-1)!);
          expect(observed.value).toBe(expectedValue);
          expect(observed.configValue).toBe(configValue);
          if (mode === "compiled") {
            const generationDirectory = path.resolve(fileURLToPath(new URL("../../", generation)));
            expect(result.stderr.match(/\[vitest-workers\] prepared/g)).toHaveLength(1);
            expect(generations).not.toContain(generation);
            generations.push(generation);
            expect(path.dirname(generationDirectory)).toBe(
              path.join(directory, ".artifacts", "vitest-workers"),
            );
            expect(fileURLToPath(generation)).toBe(
              path.join(generationDirectory, "dist/infra/fixture-worker.js"),
            );
            expect(observed.args[0]).toBe(
              path.join(generationDirectory, "dist/infra/fixture-worker.js"),
            );
            expect(fileURLToPath(observed.threadUrl)).toBe(
              path.join(generationDirectory, "dist/infra/fixture-thread.js"),
            );
            const receipts = readLines("owners.jsonl").map((line) => JSON.parse(line));
            expect(receipts).toHaveLength(generations.length);
            expect(receipts.at(-1)).toEqual({
              directory: generationDirectory,
              inputs: expect.arrayContaining([
                path.join(directory, "scripts/lib/vitest-worker-declarations.mts"),
                path.join(directory, "src/infra/fixture-sealed-leaf.ts"),
              ]),
              outputs: expect.arrayContaining([
                "managed-handoff-runtime.mjs",
                "package-update-activation-recovery.mjs",
              ]),
              durationMs: expect.any(Number),
            });
            // The real owner joins borrowers and verifies before deleting its generation.
            expect(fs.existsSync(generationDirectory)).toBe(false);
          } else {
            expect(result.stderr).not.toContain("[vitest-workers] prepared");
            expect(fileURLToPath(generation)).toBe(
              path.join(directory, "src/infra/fixture-worker.ts"),
            );
            expect(observed.args[0]).toBe("--import");
            expect(observed.args[1]).toMatch(/^file:\/\//);
            expect(fileURLToPath(observed.threadUrl)).toBe(
              path.join(directory, "src/infra/fixture-thread.ts"),
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
        expect(counts(), "unchanged parents must reuse filesystem transforms").toEqual([1, 1]);
        await launch("source");
        expect(counts()).toEqual([2, 2]);
        // A leaf edit invalidates itself while the unchanged parent reuses its
        // compiled transform, even though the next invocation builds fresh workers.
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
        fixture.assertImplementationCopies();
        console.log("copied implementations", JSON.stringify(fixture.implementationHashes));
      }),
  );
});
