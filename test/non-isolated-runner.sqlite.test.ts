import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import type { VitestReportCapture } from "../scripts/lib/vitest-report-capture.mts";
import { runVitestShutdownCommand } from "./helpers/vitest-shutdown-command.ts";
import { withRunnerFixture } from "./non-isolated-runner.fixture-support.ts";
import { sqliteLifecycleFixtureFiles } from "./non-isolated-runner.sqlite-fixtures.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
it("retires settled SQLite owners and attributes retained custody without poisoning the next file", (context) => {
  const run = withRunnerFixture("non-isolated-sqlite-lifecycle", async ({ root, args, env }) => {
    const files = sqliteLifecycleFixtureFiles();
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
    const reportPath = path.join(root, "report.json");
    const result = await runVitestShutdownCommand({
      bin: process.execPath,
      args: [
        ...args,
        "--reporter=json",
        `--reporter=${path.join(repoRoot, "scripts/lib/vitest-report-capture.mts")}`,
        `--outputFile.json=${reportPath}`,
      ],
      cwd: repoRoot,
      env: { ...env, FORCE_COLOR: undefined, NO_COLOR: "1" },
      maxBytes: 4 * 1024 * 1024,
      signal: context.signal,
    });
    expect(result.code, result.stdout + result.stderr).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Synthetic independent singleton cleanup refused");
    expect(output.match(/retained-lease-independent-reset: \d+/gu)).toEqual([
      "retained-lease-independent-reset: 1",
      "retained-lease-independent-reset: 2",
    ]);
    expect(output.match(/retained-lease-failed-reset: \d+/gu)).toEqual([
      "retained-lease-failed-reset: 1",
    ]);
    const identityMatch = output.match(/retained-lease-identity: (.+)/u);
    expect(identityMatch, output).not.toBeNull();
    const identity: { leaseId: string; path: string } = JSON.parse(identityMatch![1]!);
    expect(identity.leaseId).toMatch(/\S/u);
    expect(identity.path).toContain(path.join(root, "retained-agent-state"));
    const report: JsonTestResults = JSON.parse(await fs.readFile(reportPath, "utf8"));
    expect(report).toMatchObject({
      numTotalTests: 21,
      numPassedTests: 20,
      numFailedTests: 0,
      numPendingTests: 1,
      numTodoTests: 0,
    });
    expect(report.testResults.map((file) => path.basename(file.name)).toSorted()).toEqual(
      Object.keys(files).toSorted(),
    );
    // The fixture tests assert close/skip ordering; this layer checks teardown attribution.
    const failed = report.testResults.filter((file) => file.status === "failed");
    expect(failed.map((file) => path.basename(file.name))).toEqual(["13-a-retained-lease.test.ts"]);
    for (const detail of [
      "Synthetic retired lease cleanup refused",
      `leaseId=${identity.leaseId}`,
      `path=${identity.path}`,
    ]) {
      expect(failed[0]?.message).toContain(detail);
    }
    const capture: VitestReportCapture = JSON.parse(
      await fs.readFile(`${reportPath}.capture.json`, "utf8"),
    );
    expect(capture).toMatchObject({
      processTimedOut: false,
      ended: { reason: "failed", unhandledErrors: 0, failedModules: 1, suiteErrors: 2 },
    });
  });
  context.onTestFinished(() => run);
  return run;
});
