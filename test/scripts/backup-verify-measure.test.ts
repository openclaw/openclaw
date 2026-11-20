import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it("instruments emitted generator and archive parameter names without changing their defaults", () => {
  const directory = createTempDir("backup-measure-");
  const fixture = path.join(directory, "fixture.mjs");
  const archive = path.join(directory, "archive.gz");
  const metrics = path.join(directory, "metrics.jsonl");
  const script = path.resolve("scripts/perf/backup-verify-measure.mjs");
  fs.writeFileSync(archive, "abc");
  fs.writeFileSync(
    fixture,
    [
      "async function*gzipInParallel(e,t=6){yield t;}",
      "async function listBackupArchiveEntries(e){return e;}",
      "const out=[];for await(const n of gzipInParallel([]))out.push(n);",
      "await listBackupArchiveEntries(process.argv[2]);console.log(JSON.stringify(out));",
    ].join(""),
  );
  const node = requireNodeTool("node");
  execFileSync(node, [script, "instrument", directory]);
  for (const width of [undefined, "4"]) {
    const env: NodeJS.ProcessEnv = { ...process.env, BACKUP_MEASUREMENT: metrics };
    delete env.BACKUP_MEASURE_GZIP_CONCURRENCY;
    if (width !== undefined) {
      env.BACKUP_MEASURE_GZIP_CONCURRENCY = width;
    }
    const output = execFileSync(node, ["--import", script, fixture, archive], {
      env,
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual([width === undefined ? 6 : 4]);
  }
  const rows = fs
    .readFileSync(metrics, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.phase === "gzipInParallel")).toHaveLength(2);
  expect(
    rows
      .filter((row) => row.phase === "listBackupArchiveEntries")
      .map((row) => row.archiveReadBytes),
  ).toEqual([3, 3]);
});
