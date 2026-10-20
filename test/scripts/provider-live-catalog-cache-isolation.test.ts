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

it("releases the previous file's live catalog before a provider proxy test in the same worker", async ({
  signal,
}) => {
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
    // Keep the real extension setup and runner; ordering and worker identity
    // exercise cross-file cache reuse deterministically.
    fs.writeFileSync(
      config,
      `import { BaseSequencer } from "vitest/node";
import extensions from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "test/vitest/vitest.extensions.config.ts")).href)};
const files = ${JSON.stringify(files.map((file) => path.join(repoRoot, file).replaceAll("\\", "/")))};
class OrderedCatalogTests extends BaseSequencer {
  async sort(tests) { return [...tests].sort((a, b) => files.indexOf(a.moduleId.replaceAll("\\\\", "/")) - files.indexOf(b.moduleId.replaceAll("\\\\", "/"))); }
}
export default {
  ...extensions,
  test: {
    ...extensions.test,
    include: ${JSON.stringify(files.map((file) => file.replace(/^extensions\//u, "")))},
    setupFiles: [...extensions.test.setupFiles, ${JSON.stringify(setup)}],
    isolate: false, fileParallelism: false, maxWorkers: 1,
    sequence: { ...extensions.test.sequence, sequencer: OrderedCatalogTests },
    reporters: ["json"], outputFile: ${JSON.stringify(reportPath)},
  },
};
`,
    );
    const result = await lifetime.track(
      runNodeScript(
        [path.join(repoRoot, "scripts/run-vitest.mjs"), "--config", config, ...files],
        testRunnerFixtureEnv({
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
    expect(fs.existsSync(receipt), output).toBe(true);
    const workers = fs
      .readFileSync(receipt, "utf8")
      .trim()
      .split("\n")
      .map((line): Worker => JSON.parse(line));
    expect(
      workers.map((worker) => path.relative(repoRoot, worker.file).replaceAll("\\", "/")),
      output,
    ).toEqual(files);
    const identities = new Set(workers.map(({ pid, threadId }) => `${pid}:${threadId}`));
    expect(identities.size, output).toBe(1);
    expect(fs.existsSync(reportPath), output).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as JsonTestResults;
    const failures = report.testResults.flatMap((file) => [
      file.message,
      ...file.assertionResults.flatMap((assertion) => assertion.failureMessages ?? []),
    ]);
    expect(result.status, [output, ...failures].filter(Boolean).join("\n").slice(-16_384)).toBe(0);
    expect(report, output).toMatchObject({
      numFailedTests: 0,
      testResults: [{ status: "passed" }, { status: "passed" }],
    });
    for (const file of report.testResults) {
      expect(file.assertionResults.length, output).toBeGreaterThan(0);
    }
  });
});
