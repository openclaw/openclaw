import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import type { VitestReportCapture } from "../scripts/lib/vitest-report-capture.mts";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { runVitestShutdownCommand } from "./helpers/vitest-shutdown-command.ts";
import { sqliteLifecycleFixtureFiles } from "./non-isolated-runner.sqlite-fixtures.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

async function verifySqliteOwnerRetirement(signal: AbortSignal) {
  const fixtureRoots = path.join(repoRoot, ".artifacts", "non-isolated-sqlite-lifecycle");
  await fs.mkdir(fixtureRoots, { recursive: true });
  // openclaw-temp-dir: allow retains an unjoined or failed child fixture for diagnosis.
  const root = await fs.mkdtemp(path.join(fixtureRoots, "run-"));
  try {
    const vitestDir = path.dirname(require.resolve("vitest/package.json"));
    await fs.symlink(path.dirname(vitestDir), path.join(root, "node_modules"), "junction");
    const files = sqliteLifecycleFixtureFiles(repoRoot);
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(root, name), content);
    }
    await fs.writeFile(
      path.join(root, "vitest.config.ts"),
      `import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
class Ordered extends BaseSequencer {
  async sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
}
export default defineConfig({
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  resolve: sharedVitestConfig.resolve,
  test: {
    name: "sqlite-owner-retirement", pool: "threads", isolate: false,
    maxWorkers: 1, fileParallelism: false,
    runner: ${JSON.stringify(path.join(repoRoot, "test/non-isolated-runner.ts"))},
    sequence: { sequencer: Ordered },
  },
});
`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("VITEST") &&
          !key.startsWith("OPENCLAW_VITEST") &&
          key !== "GITHUB_ACTIONS" &&
          key !== "FORCE_COLOR",
      ),
    );
    const reportPath = path.join(root, "report.json");
    const result = await runVitestShutdownCommand({
      bin: resolveTestNodeExecPath(),
      args: [
        path.join(vitestDir, "vitest.mjs"),
        "run",
        "--root",
        root,
        "--config",
        path.join(root, "vitest.config.ts"),
        "--configLoader",
        "runner",
        "--reporter=verbose",
        "--reporter=json",
        `--reporter=${path.join(repoRoot, "scripts/lib/vitest-report-capture.mts")}`,
        `--outputFile.json=${reportPath}`,
      ],
      cwd: repoRoot,
      env: { ...env, NO_COLOR: "1" },
      maxBytes: 4 * 1024 * 1024,
      signal,
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const output = result.stdout + result.stderr;
    for (const file of Object.keys(files)) {
      const owner = file.startsWith("12-") ? "stateReadWorkers" : "sharedStateWorkerOwner";
      expect(output).toContain(`[sqlite-test-lifecycle] ${file}: retiring openclaw.${owner}`);
    }
    expect(output).toContain(
      "[sqlite-test-lifecycle] 11-a-sqlite-owner.test.ts: draining agent database custody",
    );
    const report: JsonTestResults = JSON.parse(await fs.readFile(reportPath, "utf8"));
    expect(report).toMatchObject({
      numTotalTests: 5,
      numPassedTests: 5,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    });
    expect(report.testResults.map((file) => path.basename(file.name)).toSorted()).toEqual(
      Object.keys(files).toSorted(),
    );
    for (const file of report.testResults) {
      expect(file.status).toBe("passed");
      expect(file.assertionResults).toHaveLength(1);
      expect(file.assertionResults[0]).toMatchObject({ status: "passed", failureMessages: [] });
    }
    const capture: VitestReportCapture = JSON.parse(
      await fs.readFile(`${reportPath}.capture.json`, "utf8"),
    );
    expect(capture).toMatchObject({
      processTimedOut: false,
      ended: { reason: "passed", unhandledErrors: 0, failedModules: 0, suiteErrors: 0 },
    });
    await fs.rm(root, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error) {
      error.message += `; retained fixture ${root}`;
    }
    throw error;
  }
}

it("retires SQLite owners and their callbacks before the next file installs its transport", (context) => {
  const run = verifySqliteOwnerRetirement(context.signal);
  context.onTestFinished(() => run);
  return run;
});
