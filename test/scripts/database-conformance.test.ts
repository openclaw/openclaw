import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = createTempDirTracker();
let runner: string;
const engineFiles = [
  "store.test.ts",
  "command.integration.test.ts",
  "nested/new.integration.test.ts",
];

beforeAll(() => {
  const scripts = path.join(tempDirs.make("database-conformance-"), "scripts");
  mkdirSync(scripts);
  runner = path.join(scripts, "test-database-conformance.mjs");
  copyFileSync("scripts/test-database-conformance.mjs", runner);
  mkdirSync(path.join(scripts, "lib"));
  copyFileSync(
    "scripts/lib/weighted-test-shards.mts",
    path.join(scripts, "lib/weighted-test-shards.mts"),
  );
  const config = path.join(scripts, "../config");
  mkdirSync(config);
  writeFileSync(
    path.join(config, "postgres-conformance-timings.json"),
    JSON.stringify({
      targetSeconds: {
        "src/infra/database-engine/store.test.ts": 900,
        "src/infra/database-engine/command.integration.test.ts": 800,
        "src/infra/database-engine/nested/new.integration.test.ts": 700,
      },
    }),
  );
  for (const file of engineFiles) {
    const target = path.join(scripts, "../src/infra/database-engine", file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "");
  }
  for (const file of [
    "tsx.mjs",
    "generate-postgres-schema.mts",
    "test-database-conformance-preload.mjs",
  ]) {
    writeFileSync(path.join(scripts, file), "");
  }
  writeFileSync(
    path.join(scripts, "test-projects.mts"),
    "console.log(JSON.stringify(process.argv.slice(2)));\n",
  );
});
afterAll(tempDirs.cleanup);

function run(args: string[]) {
  return spawnSync(
    resolveTestNodeExecPath(),
    [
      runner,
      "--engine",
      "postgres",
      "--connection",
      "postgresql://fixture@localhost/test",
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
}

function targets(args: string[]): string[] {
  const result = run(args);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("PostgreSQL conformance shards", () => {
  it("partitions the full target inventory without loss or overlap and forwards test options", () => {
    const full = targets([]);
    const first = targets(["--shard", "1/3"]);
    const shards = [first, targets(["--shard", "2/3"]), targets(["--shard", "3/3"])];
    expect(shards[0]).toContain("src/infra/database-engine/store.test.ts");
    expect(shards[1]).toContain("src/infra/database-engine/command.integration.test.ts");
    expect(shards[2]).toContain("src/infra/database-engine/nested/new.integration.test.ts");
    expect(shards.flat().toSorted()).toEqual(full.toSorted());
    expect(new Set(shards.flat()).size).toBe(full.length);
    expect(targets(["--shard", "1/3", "--", "--maxWorkers=1"])).toEqual([
      ...first,
      "--maxWorkers=1",
    ]);
    expect(targets(["--", "custom.test.ts", "--maxWorkers=1"])).toEqual([
      "custom.test.ts",
      "--maxWorkers=1",
    ]);
  });

  it("lists the selected targets without a database connection or catalog probe", () => {
    const result = spawnSync(
      resolveTestNodeExecPath(),
      [runner, "--engine", "postgres", "--shard", "2/3", "--list"],
      { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(targets(["--shard", "2/3"]));
  });

  it.each([
    ["--shard", "unknown"],
    ["--shard", "0/3"],
    ["--shard", "4/3"],
    ["--shard", "1/0"],
    ["--shard", "1/99999999999999999999"],
    ["--shard", "1/3", "--", "custom.test.ts"],
  ])("rejects invalid shard selection %j before running tests", (...args) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("[--shard <index>/<count>]");
    expect(result.stdout).toBe("");
  });
});
