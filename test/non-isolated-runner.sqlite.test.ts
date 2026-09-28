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
    expect(result.code, result.stdout + result.stderr).toBe(1);
    const output = result.stdout + result.stderr;
    for (const file of Object.keys(files).filter((name) => !name.startsWith("13-"))) {
      const owner = file.startsWith("12-") ? "stateReadWorkers" : "sharedStateWorkerOwner";
      expect(output).toContain(`[sqlite-test-lifecycle] ${file}: retiring openclaw.${owner}`);
    }
    expect(output).toContain(
      "[sqlite-test-lifecycle] 11-a-sqlite-owner.test.ts: draining agent database custody",
    );
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
      numTotalTests: 7,
      numPassedTests: 7,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    });
    expect(report.testResults.map((file) => path.basename(file.name)).toSorted()).toEqual(
      Object.keys(files).toSorted(),
    );
    for (const file of report.testResults) {
      const failedTeardown = path.basename(file.name) === "13-a-retained-lease.test.ts";
      expect(file.status, file.name).toBe(failedTeardown ? "failed" : "passed");
      if (failedTeardown) {
        expect(file.message).toContain("Synthetic retired lease cleanup refused");
        expect(file.message).toContain(`leaseId=${identity.leaseId}`);
        expect(file.message).toContain(`path=${identity.path}`);
      } else {
        expect(file.message, file.name).toBe("");
      }
      expect(file.assertionResults).toHaveLength(1);
      expect(file.assertionResults[0]).toMatchObject({ status: "passed", failureMessages: [] });
    }
    const capture: VitestReportCapture = JSON.parse(
      await fs.readFile(`${reportPath}.capture.json`, "utf8"),
    );
    expect(capture).toMatchObject({
      processTimedOut: false,
      ended: { reason: "failed", unhandledErrors: 0, failedModules: 1, suiteErrors: 2 },
    });
    await fs.rm(root, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error) {
      error.message += `; retained fixture ${root}`;
    }
    throw error;
  }
}

it("retires settled SQLite owners and attributes retained custody without poisoning the next file", (context) => {
  const run = verifySqliteOwnerRetirement(context.signal);
  context.onTestFinished(() => run);
  return run;
});
