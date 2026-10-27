import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createOxlintShards, filterOxlintShards } from "../../scripts/run-oxlint-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("the canonical CI scripts selection rejects unsafe test and root-script inventories", () => {
  const root = roots.make("oxlint-resource-lane-");
  const violations = ["test/qa/resource.test.ts", "test/helper.test-support.ts", "entry.mjs"];
  for (const file of [...violations, "test/fixtures/oxlint-boundary-guards/deliberate.ts"]) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'import fs from "node:fs"; fs.readdirSync("root", { recursive: true });');
  }
  writeFileSync(
    path.join(root, "test/safe.ts"),
    'import fs from "node:fs"; fs.readdirSync("root", { recursive: false });',
  );
  // No source paths are passed to the selector: this is the same --only=scripts
  // selection used by CI when hosted jobs own all core and extension stripes.
  const shards = filterOxlintShards(
    createOxlintShards({ cwd: root, env: {}, splitCore: false }),
    new Set(["scripts"]),
  );
  const selected = shards.find((shard) => shard.name === "scripts:resource-safety");
  expect(selected, "CI must own the resource-safety lane").toBeDefined();
  if (!selected) {
    throw new Error("missing resource-safety lane");
  }
  const args = selected.args.filter((arg) => arg !== "--openclaw-focused-config");
  const config = JSON.parse(readFileSync(args[1]!, "utf8"));
  const configPath = path.join(root, args[1]!);
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, jsPlugins: [path.resolve("scripts/oxlint-boundary-guards.mjs")] }),
  );
  const result = spawnSync(
    process.execPath,
    [path.resolve("node_modules/oxlint/bin/oxlint"), ...args, "--format=json"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(1);
  const report = JSON.parse(result.stdout) as {
    diagnostics: Array<{ filename: string; code: string }>;
  };
  expect(
    report.diagnostics.map((diagnostic) => diagnostic.filename.replaceAll("\\", "/")).toSorted(),
  ).toEqual(violations.toSorted());
  expect(
    report.diagnostics.every(
      (diagnostic) => diagnostic.code === "openclaw-boundaries(no-recursive-readdir)",
    ),
  ).toBe(true);
});
