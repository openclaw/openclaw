import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = process.cwd();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const suitePaths = [
  "gateway-prompt-cache.live.test.ts",
  "gateway-prompt-cache-capture.ts",
  "gateway-prompt-cache-contract.ts",
  "gateway-prompt-cache-fixture.ts",
].map((name) => `test/e2e/qa-lab/runtime/${name}`);
const manifest = JSON.stringify({
  scripts: { "test:live:cache:runtime": "node do-not-execute-selected-command.mjs" },
});
const workflow = parse(
  readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
);
const availabilityStep = workflow.jobs.validate_release_live_cache.steps.find(
  (step: { name?: string }) => step.name === "Resolve Gateway runtime cache availability",
) as { run: string };

function fixture(overrides: Record<string, string | null> = {}) {
  const root = tempDirs.make("openclaw-frozen-cache-");
  const files: Record<string, string | null> = {
    "package.json": manifest,
    ...Object.fromEntries(
      suitePaths.map((file) => [file, 'throw new Error("selected source must not execute");\n']),
    ),
    ...overrides,
  };
  for (const [relative, content] of Object.entries(files)) {
    if (content !== null) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), content);
    }
  }
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const sha = git("rev-parse", "HEAD");
  // Tooling is a separate source; selected files and package commands are data only.
  symlinkSync(repoRoot, path.join(root, ".release-harness"), "dir");
  return { root, sha, git };
}

function absentFixture() {
  return fixture({
    "package.json": JSON.stringify({ scripts: { "test:live:cache": "unchanged synthetic" } }),
    ...Object.fromEntries(suitePaths.map((file) => [file, null])),
  });
}

function runAvailability(source: ReturnType<typeof fixture>, env: Record<string, string> = {}) {
  const output = path.join(source.root, "output");
  const summary = path.join(source.root, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const result = spawnSync("bash", ["-c", availabilityStep.run], {
    cwd: source.root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      GITHUB_WORKSPACE: source.root,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "0",
      OPENCLAW_SELECTED_SHA: source.sha,
      OPENCLAW_TOOLING_SHA: source.sha,
      ...env,
    },
  });
  return {
    ...result,
    output: readFileSync(output, "utf8"),
    summary: readFileSync(summary, "utf8"),
  };
}

const historical = {
  OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
  OPENCLAW_TOOLING_SHA: "b".repeat(40),
};

function expectRejected(result: ReturnType<typeof runAvailability>, message: string) {
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain(message);
  expect(result.output).toBe("");
  expect(result.summary).toBe("");
}

describe("frozen Gateway runtime cache availability", () => {
  it.each([false, true])("runs a complete committed suite with historical opt-in %s", (enabled) => {
    const result = runAvailability(fixture(), enabled ? historical : {});
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("run_lane=true\n");
    expect(result.summary).toBe("");
  });

  it("reports NOT RUN only for a completely absent authorized historical suite", () => {
    const result = runAvailability(absentFixture(), historical);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("run_lane=false\n");
    expect(result.summary).toContain("NOT RUN");
    expect(result.summary).toContain("Synthetic cache validation is unchanged.");
  });

  it("rejects absence without the frozen-target authorization", () => {
    expectRejected(
      runAvailability(absentFixture()),
      "absence requires authorized distinct frozen-target tooling",
    );
  });

  it.each([
    {
      name: "same source",
      env: { OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1" },
      message: "distinct selected and tooling",
    },
    {
      name: "invalid opt-in",
      env: { OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "yes" },
      message: "expected 0 or 1",
    },
    {
      name: "invalid identity",
      env: { ...historical, OPENCLAW_SELECTED_SHA: "main" },
      message: "full lowercase commit SHA",
    },
    {
      name: "checkout mismatch",
      env: { OPENCLAW_SELECTED_SHA: "a".repeat(40) },
      message: "does not match",
    },
  ] as const)("rejects $name instead of omitting coverage", ({ env, message }) => {
    expectRejected(runAvailability(absentFixture(), env), message);
  });

  it.each([
    "{",
    "null",
    "[]",
    '{"scripts":null}',
    '{"scripts":[]}',
    '{"scripts":{"test:live:cache:runtime":null}}',
    '{"scripts":{"test:live:cache:runtime":""}}',
    '{"scripts":{"test:live:cache:runtime":1}}',
  ])("rejects malformed manifest %s", (content) => {
    expectRejected(
      runAvailability(fixture({ "package.json": content }), historical),
      "Gateway runtime cache availability:",
    );
  });

  it.each(suitePaths)("rejects a partial backport missing %s", (file) => {
    expectRejected(
      runAvailability(fixture({ [file]: null }), historical),
      "incomplete Gateway runtime cache contract",
    );
  });

  it.each([
    { name: "missing command", files: { "package.json": "{}" } },
    { name: "missing suite", files: Object.fromEntries(suitePaths.map((file) => [file, null])) },
    { name: "empty suite file", files: { [suitePaths[0]!]: "" } },
  ] as const)("rejects $name rather than reporting unsupported", ({ files }) => {
    expectRejected(
      runAvailability(fixture(files), historical),
      "incomplete Gateway runtime cache contract",
    );
  });

  it("does not treat a missing package as historical absence", () => {
    expectRejected(
      runAvailability(fixture({ "package.json": null }), historical),
      "missing selected package.json",
    );
  });

  it.each(["package.json", suitePaths[0]!])("propagates unreadable committed %s", (file) => {
    const source = fixture();
    const oid = source.git("rev-parse", `${source.sha}:${file}`);
    rmSync(path.join(source.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    expectRejected(runAvailability(source, historical), "unable to read selected source");
  });

  it("ignores dirty source when the committed suite is present", () => {
    const source = fixture();
    writeFileSync(path.join(source.root, "package.json"), "{");
    rmSync(path.join(source.root, suitePaths[0]!));
    const result = runAvailability(source);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("run_lane=true\n");
  });

  it("does not infer a historical suite from untracked current files", () => {
    const source = absentFixture();
    writeFileSync(path.join(source.root, "package.json"), manifest);
    for (const file of suitePaths) {
      mkdirSync(path.dirname(path.join(source.root, file)), { recursive: true });
      writeFileSync(path.join(source.root, file), "export {};\n");
    }
    const result = runAvailability(source, historical);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("run_lane=false\n");
    expect(result.summary).toContain("NOT RUN");
  });
});
