import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveChangedNodeTestTargets } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { writeFiles } from "./ci-changed-node-test-plan.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const inventory = "test/vitest-projects-config.test.ts";

it("audits added opt-in tests and rename destinations without auditing ordinary edits", () => {
  const cwd = tempDirs.make("ci-added-test-selection-");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd, env: createNestedGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const existing = "scripts/control-ui-retention/existing.test.ts";
  const oldPath = "scripts/control-ui-retention/old.test.ts";
  const renamed = "scripts/control-ui-retention/renamed.test.ts";
  const added = "scripts/control-ui-retention/dependency-retention.test.ts";
  writeFiles(cwd, [inventory, existing, oldPath]);
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture baseline");
  const baseRef = git("rev-parse", "HEAD");
  renameSync(path.join(cwd, oldPath), path.join(cwd, renamed));
  writeFiles(cwd, {
    [existing]: "export const changed = true;\n",
    [added]: "export {};\n",
    "apps/example/probe.spec.mts": "export {};\n",
    "probe.test.ts": "export {};\n",
    "src/example/new.test.ts": "export {};\n",
    "scripts/example.live.test.ts": "export {};\n",
    "scripts/example.e2e.test.ts": "export {};\n",
  });
  git("add", ".");
  const select = (paths: string[]) =>
    resolveChangedNodeTestTargets(paths, { cwd, baseRef, selectionMode: "aggressive" });

  for (const paths of [
    [added],
    [oldPath, renamed],
    ["apps/example/probe.spec.mts"],
    ["probe.test.ts"],
  ]) {
    expect(select(paths), paths.join(", ")).toContain(inventory);
  }
  for (const paths of [
    [existing],
    [oldPath],
    ["src/example/new.test.ts"],
    ["scripts/example.live.test.ts"],
    ["scripts/example.e2e.test.ts"],
  ]) {
    expect(select(paths), paths.join(", ")).not.toContain(inventory);
  }
});
