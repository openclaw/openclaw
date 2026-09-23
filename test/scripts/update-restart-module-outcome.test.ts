import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { nativeTestRunnerArgs } from "../../scripts/lib/native-test-runner.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const regression = fileURLToPath(
  new URL("../../scripts/tests/update-restart-module-outcome.mjs", import.meta.url),
);

test("retains package backups after unverified post-swap module failures", async () => {
  const junitReport = process.versions.bun
    ? path.join(tempDirs.make("update-restart-outcome-"), "results.xml")
    : undefined;
  const { stdout } = await execFileAsync(
    process.execPath,
    nativeTestRunnerArgs([regression], {
      node: ["--experimental-vm-modules", "--test-reporter=tap"],
      bun: junitReport ? ["--reporter=junit", "--reporter-outfile", junitReport] : [],
    }),
    {
      cwd: sourceRoot,
      // Bind the child to this checkout, not a historical proof override.
      env: {
        ...process.env,
        RESTART_SOURCE_ROOT: sourceRoot,
        RESTART_TRANSACTION_SOURCE_ROOT: sourceRoot,
        RESTART_DEPENDENCY_ROOT: sourceRoot,
        RESTART_VARIANT: "main",
      },
      timeout: 30_000,
    },
  );
  if (junitReport) {
    const report = await readFile(junitReport, "utf8");
    // Read only the native reporter's aggregate attributes, not fixture stdout.
    const summary = report.match(/<testsuites\b[^>]*>/)?.[0];
    expect(summary).toMatch(/\btests="19"/);
    expect(summary).toMatch(/\bfailures="0"/);
    expect(summary).toMatch(/\bskipped="0"/);
    expect(report.trimEnd()).toMatch(/<\/testsuites>$/);
  } else {
    expect(stdout).toMatch(/^# tests 19$/m);
    expect(stdout).toContain("# fail 0");
    expect(stdout).toMatch(/^# skipped 0$/m);
  }
}, 35_000);
