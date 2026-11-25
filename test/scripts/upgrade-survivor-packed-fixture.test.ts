import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("fails rather than rebuilding when a supplied successor is missing or from another commit", () => {
  const dir = tempDirs.make("survivor-fixture-");
  const prebuilt = join(dir, "prebuilt");
  const stage = join(dir, "stage");
  const current = join(dir, "current.tgz");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  mkdirSync(prebuilt);
  mkdirSync(stage);
  mkdirSync(join(dir, "package/dist"), { recursive: true });
  function pack(file: string, source: string, schema: number) {
    writeFileSync(
      join(dir, "package/package.json"),
      JSON.stringify({ version: "2026.11.1", openclaw: { schemaVersions: { state: schema } } }),
    );
    writeFileSync(
      join(dir, "package/dist/build-info.json"),
      JSON.stringify({ commit: source, buildId: `schema-${schema}` }),
    );
    execFileSync("tar", ["-czf", file, "-C", dir, "package"]);
  }
  pack(current, commit, 41);
  const run = () =>
    spawnSync(
      process.execPath,
      [
        resolve("scripts/e2e/lib/upgrade-survivor/release-fixture.mjs"),
        process.cwd(),
        current,
        stage,
        prebuilt,
      ],
      { encoding: "utf8" },
    );
  expect(run().stderr).toMatch(/ENOENT.*next\.tgz/u);
  pack(join(prebuilt, "next.tgz"), "0".repeat(40), 42);
  expect(run().stderr).toContain("T+1 must be built from the selected source");
  pack(join(prebuilt, "next.tgz"), commit, 42);
  const accepted = run();
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(stage, "fixture.json"), "utf8")).next).toMatchObject({
    buildId: "schema-42",
    schema: 42,
  });
});
