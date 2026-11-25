import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scripts = resolve("scripts/e2e/lib/upgrade-survivor");
const successor = join(scripts, "release-fixture.mjs");
const downgrade = join(scripts, "schema-downgrade-source.mjs");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

function write(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(repo: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function commit(repo: string) {
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "source",
  );
  return git(repo, "rev-parse", "HEAD");
}

function manifest(version: string, state: number) {
  return { name: "openclaw", version, openclaw: { schemaVersions: { state, agent: 3 } } };
}

function fixture() {
  const root = tempDirs.make("upgrade-survivor-packed-");
  const repo = join(root, "repo");
  const output = join(root, "output");
  const buildLog = join(root, "build.log");
  const bin = join(root, "bin");
  write(join(bin, "pnpm"), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$BUILD_LOG"\n');
  chmodSync(join(bin, "pnpm"), 0o755);
  // Stub the expensive build edges, but exercise real Git, gzip tar, and CLI dispatch.
  const packageScript = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";
const args = process.argv.slice(2);
assert(args.includes("--skip-build") && !args.includes("--runtime-only"));
const output = join(args[args.indexOf("--output-dir") + 1], args[args.indexOf("--output-name") + 1]);
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("packed/package/dist", { recursive: true });
writeFileSync("packed/package/package.json", JSON.stringify(manifest));
writeFileSync("packed/package/dist/build-info.json", JSON.stringify({
  version: manifest.version, commit: process.env.GIT_COMMIT, buildId: process.env.OPENCLAW_CONTROL_UI_BUILD_ID,
}));
execFileSync("tar", ["-czf", output, "-C", "packed", "package"]);
`;
  write(join(repo, "scripts/package-openclaw-for-docker.mjs"), packageScript);
  write(join(repo, "scripts/tsx.mjs"), "");
  write(join(repo, "scripts/write-unified-entry-dts.ts"), "");
  write(join(repo, "package.json"), JSON.stringify(manifest("2026.11.1", 41)));
  git(repo, "init", "-q");
  const env = {
    ...process.env,
    BUILD_LOG: buildLog,
    PATH: [bin, process.env.PATH].join(delimiter),
  };
  const run = (script: string, ...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  function pass(script: string, ...args: string[]) {
    const result = run(script, ...args);
    expect(result.status, result.stderr).toBe(0);
  }
  function pack(source: string, buildId: string) {
    execFileSync(
      process.execPath,
      [
        join(repo, "scripts/package-openclaw-for-docker.mjs"),
        "--skip-build",
        "--output-dir",
        root,
        "--output-name",
        "current.tgz",
      ],
      {
        cwd: repo,
        env: { ...env, GIT_COMMIT: source, OPENCLAW_CONTROL_UI_BUILD_ID: buildId },
      },
    );
    return join(root, "current.tgz");
  }
  return { repo, output, buildLog, run, pass, pack };
}

it("joins an independently prepared successor with the actual candidate without rebuilding", () => {
  const { repo, output, buildLog, run, pass, pack } = fixture();
  for (const [filename, anchors] of Object.entries({
    "src/state/openclaw-schema-versions.ts": "export const OPENCLAW_STATE_SCHEMA_VERSION = 41;",
    "src/state/openclaw-state-schema.sql": "",
    "src/state/openclaw-state-db-maintenance.ts":
      'import type { DatabaseSync } from "node:sqlite";\n  stateApprovalProfileMigration,\n] as const;\n    stateApprovalProfileMigration,\n  ];',
    "src/state/openclaw-state-schema-runtime.ts": "  let schema = OPENCLAW_STATE_SCHEMA_SQL;",
    "scripts/lib/sqlite-schema-inputs.mts":
      "for (const version of [41,\n      for (const [era, schema] of [",
    "src/infra/database-engine/state-port-descriptor.ts":
      "OPENCLAW_STATE_SCHEMA_VERSION !== 41\n38, 39, 40].includes(sourceVersion)",
  })) {
    write(join(repo, filename), anchors);
  }
  const head = commit(repo);
  const candidate = pack(head, "actual-current-build");
  pass(successor, "--prepare", repo, output);
  expect(existsSync(join(output, "fixture.json"))).toBe(false);
  expect(existsSync(join(output, "source"))).toBe(false);
  expect(readJson(join(repo, "package.json"))).toEqual(manifest("2026.11.2-beta.1", 42));
  pass(successor, "--verify", repo, candidate, output);
  const receipt = join(output, "fixture.json");
  expect(readJson(receipt)).toEqual({
    previous: { commit: head, schema: 41, version: "2026.11.1", buildId: "actual-current-build" },
    next: { schema: 42, version: "2026.11.2-beta.1", buildId: expect.stringContaining(head) },
    timingsMs: {
      sourceSetup: expect.any(Number),
      schemaGeneration: expect.any(Number),
      build: expect.any(Number),
      declarations: expect.any(Number),
      package: expect.any(Number),
    },
  });
  expect(readFileSync(buildLog, "utf8")).toBe("db:postgres:gen\nbuild:ci-artifacts\n");
  appendFileSync(join(output, "next.tgz"), "modified after preparation");
  const rejected = run(successor, "--verify", repo, candidate, output);
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain("digest mismatch");
  expect(existsSync(receipt)).toBe(false);
});

it("validates the selected fork point and the actual previous and candidate build identities", () => {
  const { repo, output, buildLog, run, pass, pack } = fixture();
  const file = join(repo, "src/state/openclaw-state-db-schema-version.ts");
  write(file, "export const schemaVersion = 41;\n");
  const base = commit(repo);
  write(file, "export function readStateSchemaMinReader() {}\n");
  write(join(repo, "package.json"), JSON.stringify(manifest("2026.11.2", 42)));
  const head = commit(repo);
  const candidate = pack(head, "actual-candidate-build");
  pass(downgrade, "--select", repo, output, base);
  const receiptFile = join(output, "downgrade-source.json");
  const savedSelection = readFileSync(receiptFile, "utf8");
  const rejected = run(downgrade, "--build", repo, output);
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain("wrong fork-point checkout");
  git(repo, "checkout", "--detach", "-q", base);
  pass(downgrade, "--build", repo, output);
  git(repo, "checkout", "--detach", "-q", head);
  pass(downgrade, "--verify", repo, candidate, output, base);
  expect(readJson(receiptFile)).toMatchObject({
    selected: true,
    previousSource: base,
    candidateSource: head,
    previousBuild: { commit: base, version: "2026.11.1", buildId: expect.stringContaining(base) },
    candidateBuild: {
      commit: head,
      version: "2026.11.2",
      buildId: "actual-candidate-build",
      readerFloorSupported: true,
    },
  });
  expect(readFileSync(buildLog, "utf8")).toBe("build:ci-artifacts\n");
  write(receiptFile, savedSelection.replace(head, base));
  const mismatched = run(downgrade, "--verify", repo, candidate, output, base);
  expect(mismatched.status).not.toBe(0);
  expect(mismatched.stderr).toContain("downgrade selection does not match");

  pass(downgrade, "--select", repo, output, head);
  pass(downgrade, "--verify", repo, join(output, "not-needed.tgz"), output, head);
  expect(readJson(receiptFile)).toMatchObject({ selected: false, changedPaths: [] });
});
