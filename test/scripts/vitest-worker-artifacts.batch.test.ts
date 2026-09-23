import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  createControlledWorkerCompiler,
  createWorkerArtifactTest,
  workerBorrowingProbe,
  writeFixture,
} from "./vitest-worker-artifacts.test-support.js";

const it = createWorkerArtifactTest();
const root = process.cwd();

it.runIf(process.platform !== "win32").for([0, 1])(
  "owns compiled worker artifacts through batch completion (exit %s)",
  (expectedCode, { workerArtifacts }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const { node } = workerArtifacts.createFixtureCommands();
      const directory = workerArtifacts.fixtureDirectory();
      const { config } = workerBorrowingProbe(directory);
      const observed = path.join(directory, "generations.jsonl");
      const completed = path.join(directory, "completed.json");
      if (expectedCode !== 0) {
        fs.appendFileSync(
          path.join(directory, "child.test.ts"),
          "\nit('reports the fixture failure', () => expect.fail('deliberate batch failure'));\n",
        );
      }
      const entry = writeFixture(
        directory,
        "batch.mts",
        `import fs from 'node:fs';
import {runVitestBatch} from ${JSON.stringify(path.join(root, "scripts/lib/vitest-batch-runner.mts"))};
process.exitCode = await runVitestBatch({
  config: ${JSON.stringify(config)}, args: ['--maxWorkers=1', '--cache=false'], targets: [], env: process.env,
  onComplete(outcome) {
    const generations = fs.existsSync(${JSON.stringify(observed)})
      ? fs.readFileSync(${JSON.stringify(observed)}, 'utf8').trim().split('\\n').map(line => JSON.parse(line)) : [];
    fs.writeFileSync(${JSON.stringify(completed)}, JSON.stringify({
      ...outcome, generationPresent: generations.some(url => fs.existsSync(new URL('../../', url))),
    }));
  },
});`,
      );
      const compiler = createControlledWorkerCompiler(directory, process.env);
      const result = await node(
        ["--import", path.join(root, "scripts/tsx.mjs"), entry],
        root,
        compiler.env,
      );
      expect(result.code, result.stdout + result.stderr).toBe(expectedCode);
      expect(fs.existsSync(observed)).toBe(true);
      expect(JSON.parse(fs.readFileSync(completed, "utf8"))).toEqual({
        code: expectedCode,
        signal: null,
        generationPresent: false,
      });
      const generations: string[] = fs
        .readFileSync(observed, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(generations).toHaveLength(2);
      expect(new Set(generations).size).toBe(1);
      expect(compiler.read()).toHaveLength(1);
      for (const generation of generations) {
        expect(generation.endsWith("/dist/infra/sqlite-readonly-location.worker.js")).toBe(true);
        expect(fs.existsSync(fileURLToPath(new URL("../../", generation)))).toBe(false);
      }
      expect((result.stdout + result.stderr).match(/\[vitest-workers\] prepared/g)).toHaveLength(1);
    }),
);
