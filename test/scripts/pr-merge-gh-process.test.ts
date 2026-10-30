import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMergeGhFixturePrograms } from "./pr-merge-gh-process.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

it.each([0, 7])("drains CLI response pipes before exiting with status %s", (status) => {
  const directory = temps.make("pr-gh-response-");
  const cli = join(directory, "gh.cjs");
  const stdout = "x".repeat(1024 * 1024);
  const stderr = "error".repeat(256 * 1024);
  writeFileSync(
    cli,
    createMergeGhFixturePrograms(`
      process.stdout.write("x".repeat(1024 * 1024));
      process.stderr.write("error".repeat(256 * 1024));
      process.exit(${status});
    `).cli,
  );

  const result = spawnSync(requireNodeTool("node"), [...resolveVitestNodeArgs(), cli, "direct"], {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status);
  expect(result.stdout.length).toBe(stdout.length);
  expect(result.stderr.length).toBe(stderr.length);
  expect(result.stdout).toBe(stdout);
  expect(result.stderr).toBe(stderr);
});
