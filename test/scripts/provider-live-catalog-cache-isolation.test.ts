import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../vitest/vitest.timeouts.js";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());
const repoRoot = path.resolve(import.meta.dirname, "../..");
const files = [
  "extensions/deepinfra/surface-model-catalogs.test.ts",
  "extensions/deepinfra/provider-models.proxy.test.ts",
];
type Worker = { file: string; pid: number; threadId: number };

it("isolates live catalogs between files in one worker", async ({ signal }) => {
  await lifetime.run(async () => {
    const root = lifetime.createTempDir("oc-catalog-isolation-");
    const local = (name: string) => path.join(root, name);
    const config = local("vitest.config.mjs");
    const setup = local("record-worker.mjs");
    const receipt = local("workers.jsonl");
    const reportPath = local("report.json");
    fs.symlinkSync(path.join(repoRoot, "node_modules"), local("node_modules"), "junction");
    fs.writeFileSync(
      setup,
      `import fs from "node:fs";
import { threadId } from "node:worker_threads";
import { beforeAll, expect } from "vitest";
beforeAll(() => fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({
  file: expect.getState().testPath, pid: process.pid, threadId,
}) + "\\n"));
`,
    );
    // Real extension setup, explicit order, and one worker reproduce cross-file cache reuse.
    fs.writeFileSync(
      config,
      `import { BaseSequencer } from "vitest/node";
import extensions from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "test/vitest/vitest.extensions.config.ts")).href)};
const files = ${JSON.stringify(files.map((file) => path.join(repoRoot, file).replaceAll("\\", "/")))};
class OrderedCatalogTests extends BaseSequencer {
  async sort(tests) { return [...tests].sort((a, b) => files.indexOf(a.moduleId.replaceAll("\\\\", "/")) - files.indexOf(b.moduleId.replaceAll("\\\\", "/"))); }
}
extensions.test = {
    ...extensions.test,
    include: ${JSON.stringify(files.map((file) => file.replace(/^extensions\//u, "")))},
    setupFiles: [...extensions.test.setupFiles, ${JSON.stringify(setup)}],
    isolate: false, fileParallelism: false, maxWorkers: 1,
    sequence: { ...extensions.test.sequence, sequencer: OrderedCatalogTests },
    reporters: ["json"], outputFile: ${JSON.stringify(reportPath)},
};
export default extensions;
`,
    );
    const result = await lifetime.track(
      runNodeScript(
        [path.join(repoRoot, "scripts/run-vitest.mjs"), "--config", config, ...files],
        testRunnerFixtureEnv({
          // Reuse this runtime instead of staging Bun again under the fixture's isolated HOME.
          OPENCLAW_VITEST_RUNTIME: process.versions.bun ? "bun" : "node",
          ...(process.versions.bun ? { OPENCLAW_BUN_PATH: process.execPath } : {}),
          OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: local("module-cache"),
        }),
        DEFAULT_VITEST_TEST_TIMEOUT_MS,
        {
          cwd: repoRoot,
          signal,
          maxBuffer: 2 * 1024 * 1024,
          requireProcessTreeExit: process.platform !== "win32",
        },
      ),
    );
    const output = [result.error, result.stderr, result.stdout].filter(Boolean).join("\n");
    const lines = fs.readFileSync(receipt, "utf8").trim().split("\n");
    const workers = lines.map((line): Worker => JSON.parse(line));
    const paths = workers.map(({ file }) => path.relative(repoRoot, file).replaceAll("\\", "/"));
    expect(paths, output).toEqual(files);
    const identities = new Set(workers.map(({ pid, threadId }) => `${pid}:${threadId}`));
    expect(identities.size, output).toBe(1);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as JsonTestResults;
    expect(result.status, output).toBe(0);
    expect(report.numFailedTests, output).toBe(0);
    expect(
      report.testResults.map(({ status }) => status),
      output,
    ).toEqual(["passed", "passed"]);
    for (const file of report.testResults) {
      expect(file.assertionResults.length, output).toBeGreaterThan(0);
    }
  });
});
