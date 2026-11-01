import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let runner: string;
const engineFiles = ["unit.test.ts", "nested/integration.test.ts"];

beforeAll(() => {
  const scripts = path.join(tempDirs.make("database-conformance-"), "scripts");
  const write = (file: string, content = "") => {
    const target = path.join(scripts, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  mkdirSync(path.join(scripts, "lib"), { recursive: true });
  runner = path.join(scripts, "test-database-conformance.mjs");
  copyFileSync("scripts/test-database-conformance.mjs", runner);
  copyFileSync(
    "scripts/lib/postgres-conformance-shards.mts",
    path.join(scripts, "lib/postgres-conformance-shards.mts"),
  );
  write(
    "../config/postgres-conformance-timings.json",
    JSON.stringify({
      files: {},
      workers: 1,
      preparationSeconds: { base: 0, runtime: 0 },
      groupSeconds: {},
      runtimeTargets: [],
    }),
  );
  for (const file of [
    ...engineFiles.map((engineFile) => `../src/infra/database-engine/${engineFile}`),
    "tsx.mjs",
    "generate-postgres-schema.mts",
    "test-database-conformance-preload.mjs",
  ]) {
    write(file);
  }
  copyFileSync("src/infra/directory-walk.ts", path.join(scripts, "../src/infra/directory-walk.ts"));
  write("test-projects.mts", "console.log(JSON.stringify(process.argv.slice(2)));\n");
});

function run(args: string[], connection = true) {
  const connectionArgs = connection ? ["--connection", "postgresql://fixture@localhost/test"] : [];
  return spawnSync(
    resolveTestNodeExecPath(),
    [runner, "--engine", "postgres", ...connectionArgs, ...args],
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
    const shards = [1, 2, 3].map((index) => targets(["--shard", `${index}/3`]));
    expect(shards.flat().toSorted()).toEqual(full.toSorted());
    expect(new Set(shards.flat()).size).toBe(full.length);
    const firstShard = shards[0]!;
    const options = ["--maxWorkers=1"];
    expect(targets(["--shard", "1/3", "--", ...options])).toEqual([...firstShard, ...options]);
    const custom = ["custom.test.ts", ...options];
    expect(targets(["--", ...custom])).toEqual(custom);
  });

  it("lists the selected targets without a database connection or catalog probe", () => {
    const result = run(["--shard", "2/3", "--list"], false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(targets(["--shard", "2/3"]));
  });

  it.each([
    ["--shard", "unknown"],
    ["--shard", "4/3"],
    ["--shard", "1/99999999999999999999"],
    ["--shard", "1/3", "--", "custom.test.ts"],
  ])("rejects invalid shard selection %j before running tests", (...args) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("[--shard <index>/<count>]");
    expect(result.stdout).toBe("");
  });
});
