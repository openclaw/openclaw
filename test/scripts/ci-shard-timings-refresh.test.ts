import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const run = {
  id: 321,
  run_attempt: 1,
  path: ".github/workflows/ci.yml",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "failure",
  display_title: "CI full-release-validation-123-1-ci",
  head_sha: "a".repeat(40),
  repository: { full_name: "openclaw/openclaw" },
};
const baseline = {
  version: 1,
  updatedAt: "2026-09-01",
  source: "fixture",
  compactGroupSeconds: {
    blacksmith: { other: 99 },
    github: { compact: 17, "release-full-retained": 2000 },
  },
  runtimePlacementTimings: { blacksmith: [], github: [] },
  toolingFileSeconds: { blacksmith: {}, github: {} },
  repoE2eFileSeconds: {},
  uiE2e: { fileSeconds: {}, perFileOverheadSeconds: 0 },
};
const job = {
  id: 1,
  run_id: 321,
  run_attempt: 1,
  head_sha: run.head_sha,
  name: "checks-node-fixture",
  status: "completed",
  conclusion: "success",
  started_at: "2026-09-01T01:00:00Z",
  completed_at: "2026-09-01T01:15:00Z",
  labels: ["ubuntu-24.04"],
  steps: [{ name: "Run Node test shard" }],
};
function log(shard_name: string, timing_key?: string, files?: string[]) {
  const group = {
    shard_name,
    ...(timing_key ? { timing_key } : {}),
    configs: ["test/vitest/vitest.unit.config.ts"],
    ...(files ? { includePatterns: files } : {}),
  };
  const key = timing_key ?? shard_name;
  return `2026-09-01T01:01:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([group])}\n2026-09-01T01:02:00Z [shard:${key}] begin\n2026-09-01T01:04:00Z [shard:${key}] end (exit 0)\n`;
}
function execute(
  options: { after?: typeof run; jobs?: Array<typeof job>; logs?: Record<string, string> } = {},
) {
  const root = tempRoots.make("ci-shard-refresh-");
  const out = join(root, "timings.json");
  writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);
  const before = readFileSync(out, "utf8");
  const jobs = options.jobs ?? [job];
  writeFileSync(
    join(root, "fixture.json"),
    JSON.stringify({
      run,
      after: options.after ?? run,
      jobs,
      logs: options.logs ?? { "1": log("fixture") },
    }),
  );
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path'); const root = __dirname; const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'))); const endpoint = process.argv[3]; if (endpoint === '--help') { process.stdout.write('--allow-escape-sequences'); process.exit(0); } let result; if (endpoint.endsWith('/actions/runs/321')) { const counter = path.join(root, 'read'); result = fs.existsSync(counter) ? fixture.after : fixture.run; fs.writeFileSync(counter, '1'); } else if (endpoint.includes('/attempts/1/jobs?')) { result = { total_count: fixture.jobs.length, jobs: fixture.jobs }; } else { const id = /jobs\\/(\\d+)\\/logs$/.exec(endpoint)?.[1]; if (!id || !fixture.logs[id]) process.exit(7); process.stdout.write(fixture.logs[id]); process.exit(0); } process.stdout.write(JSON.stringify(result));\n`,
  );
  chmodSync(gh, 0o755);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/ci-shard-timings-refresh.mts",
      "--run",
      "321",
      "--out",
      out,
    ],
    {
      cwd: resolve(import.meta.dirname, "../.."),
      env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}` },
      encoding: "utf8",
    },
  );
  return { result, before, bytes: readFileSync(out, "utf8") };
}

describe("release shard timing refresh CLI", () => {
  it.each([
    { name: "whole owner", files: undefined },
    { name: "explicit files", files: ["test/fixture.test.ts"] },
    { name: "wildcard owner", files: ["src/**/*.test.ts"] },
  ])(
    "writes $name timings while retaining unrelated costs and skipping other jobs",
    ({ files }) => {
      const { result, bytes } = execute({
        jobs: [
          job,
          { ...job, id: 2, conclusion: "failure" },
          { ...job, id: 3, labels: ["ubuntu-24.04", "self-hosted"] },
          { ...job, id: 4, labels: ["blacksmith-4vcpu-ubuntu-2404"] },
          { ...job, id: 5 },
          {
            ...job,
            id: 6,
            name: "checks-node-compat-node24",
            steps: [{ name: "Run Node 24 minimum compatibility" }],
          },
          { ...job, id: 7, name: "checks-node-compact-small-1" },
          { ...job, id: 8, name: "checks-node-release-packed-1" },
        ],
        logs: {
          "1": log("fixture", undefined, files),
          "5": log("retained", "release-full-retained"),
          "6": "2026-09-01T01:04:00Z Node 24 compatibility succeeded\n",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const written = JSON.parse(bytes);
      if (files?.[0] === "test/fixture.test.ts") {
        expect(Object.entries(written.compactGroupSeconds.github)).toEqual(
          expect.arrayContaining([
            [
              expect.stringMatching(
                /^release-full-fixture#selector-1-[a-f0-9]{12}#generation-[a-f0-9]{12}#part-1-of-1#include-1-[a-f0-9]{12}$/u,
              ),
              900,
            ],
          ]),
        );
      } else {
        expect(written.compactGroupSeconds).toEqual({
          blacksmith: { other: 99 },
          github: { compact: 17, "release-full-fixture": 900, "release-full-retained": 2000 },
        });
      }
      expect(bytes).toBe(`${JSON.stringify(written, null, 2)}\n`);
      expect(written.source).toContain("Release CI 321 attempt 1");
    },
  );

  it.each([
    {
      label: "missing descriptor",
      log: "2026-09-01T01:04:00Z [shard:fixture] end (exit 0)\n",
      error: "one unambiguous shard descriptor",
    },
    {
      label: "ambiguous descriptors",
      log: log("fixture") + log("other"),
      error: "one unambiguous shard descriptor",
    },
    {
      label: "unsuccessful shard span",
      log: log("fixture").replace("end (exit 0)", "end (exit 1)"),
      error: "successful matching shard span",
    },
  ])(
    "rejects a planned shard with $label without changing timing bytes",
    ({ log: shardLog, error }) => {
      const { result, before, bytes } = execute({ logs: { "1": shardLog } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
      expect(bytes).toBe(before);
    },
  );

  it.each([
    { label: "run retry", after: { ...run, run_attempt: 2 } },
    { label: "wrong job attempt", jobs: [{ ...job, run_attempt: 2 }] },
    { label: "wrong job source", jobs: [{ ...job, head_sha: "b".repeat(40) }] },
  ])("leaves the committed timing bytes untouched on $label", (options) => {
    const { result, before, bytes } = execute(options);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/attempt|identity/u);
    expect(bytes).toBe(before);
  });
});
