import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listDirectoryTreeStrictSync } from "../../src/infra/directory-walk.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let runner: string;
const engineFiles = ["unit.test.ts", "nested/integration.test.ts", "support.ts", "ignored.spec.ts"];

beforeAll(() => {
  const scripts = path.join(tempDirs.make("database-conformance-"), "scripts");
  const write = (file: string, content = "") => {
    const target = path.join(scripts, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write("../package.json", JSON.stringify({ type: "module" }));
  mkdirSync(path.join(scripts, "lib"), { recursive: true });
  runner = path.join(scripts, "test-database-conformance.mjs");
  copyFileSync("scripts/test-database-conformance.mjs", runner);
  for (const name of ["postgres-conformance-shards.mts", "changed-path-facts.mjs"]) {
    copyFileSync(`scripts/lib/${name}`, path.join(scripts, "lib", name));
  }
  write("../package.json", JSON.stringify({ type: "module" }));
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
  it("selects every PostgreSQL suite in the repository", () => {
    const result = spawnSync(
      resolveTestNodeExecPath(),
      ["scripts/test-database-conformance.mjs", "--engine", "postgres", "--list"],
      { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
    );
    expect(result.status, result.stderr).toBe(0);
    const selected: string[] = JSON.parse(result.stdout);
    const suites = ["src", "extensions"].flatMap((root) =>
      listDirectoryTreeStrictSync(root)
        .filter((entry) => entry.relativePath.endsWith(".postgres.test.ts"))
        .map((entry) => `${root}/${entry.relativePath.replaceAll("\\", "/")}`),
    );
    expect(
      suites.filter(
        (file) => !selected.some((target) => file === target || file.startsWith(`${target}/`)),
      ),
    ).toEqual([]);
  });

  it("partitions the full target inventory without loss or overlap and forwards test options", () => {
    const full = targets([]);
    expect(full).toEqual(
      expect.arrayContaining([
        "src/infra/exec-approvals-native.test.ts",
        "src/infra/client-credential-update.test.ts",
        "src/infra/update-managed-service-handoff-engine.test.ts",
      ]),
    );
    expect(full.filter((file) => file.startsWith("src/infra/database-engine/"))).toEqual([
      "src/infra/database-engine/nested/integration.test.ts",
      "src/infra/database-engine/unit.test.ts",
    ]);
    const shards = [1, 2, 3].map((index) => targets(["--shard", `${index}/3`]));
    expect(shards.flat().toSorted()).toEqual(full.toSorted());
    expect(new Set(shards.flat()).size).toBe(full.length);
    for (const shard of shards) {
      expect(shard).toEqual(full.filter((target) => shard.includes(target)));
    }
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

  // Node writes asynchronously to POSIX pipes; Windows pipes are synchronous.
  it.skipIf(process.platform === "win32")("flushes a large target list before exiting", () => {
    const custom = Array.from(
      { length: 1024 },
      (_, index) => `custom/${"large-target/".repeat(10)}${index}.test.ts`,
    );
    const result = run(["--list", "--", ...custom], false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(custom);
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
