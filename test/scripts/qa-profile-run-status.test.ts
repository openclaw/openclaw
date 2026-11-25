import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveWorkflowBash } from "../helpers/workflow-bash.js";

let cachedWorkflowBash: string | undefined;
const workflowBash = () =>
  process.platform === "darwin" ? (cachedWorkflowBash ??= resolveWorkflowBash()) : "bash";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const windows = process.platform === "win32";
const statusFile = "qa-profile-run-status.json";
const collectorPath = path.join(repoRoot, "scripts/qa/qa-profile-run-status.mjs");
function workflowStep(file: string, job: string, name: string): string {
  const workflow = parse(fs.readFileSync(path.join(repoRoot, ".github/workflows", file), "utf8"));
  return workflow.jobs[job].steps.find((step: { name: string }) => step.name === name).run;
}
const aggregateStep = (name: string) =>
  workflowStep("qa-profile-evidence.yml", "aggregate_qa_profile", name);
function shell(script: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(workflowBash(), ["-c", script], { cwd, env, encoding: "utf8" });
}
const targetSha = "a".repeat(40);
const protocolSha = "b".repeat(40);
const plan = {
  include: [
    { id: "shard-01", categoryIds: ["fixture.one"], scenarioIds: ["scenario-one"] },
    { id: "shard-02", categoryIds: ["fixture.two"], scenarioIds: ["scenario-two"] },
  ],
};

const completion = {
  exitCode: 0,
  timedOut: false,
  timeoutOutcome: "none",
  completedAt: "2026-09-10T00:00:00.000Z",
};
const killed = { ...completion, exitCode: 137, timedOut: true, timeoutOutcome: "kill" };
const unknownOutcome = { exitCode: null, timedOut: null, timeoutOutcome: null };

function fixture(layout: "named" | "direct" = "named") {
  const root = tempDirs.make("openclaw-qa-profile-status-");
  const originals = new Map<string, Buffer>();
  const put = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    originals.set(file, Buffer.from(text));
  };
  const input = path.join(root, ".artifacts/qa-profile-shards");
  const output = path.join(root, ".artifacts/qa-e2e/profile-all-42-1");
  const env = {
    PATH: process.env.PATH ?? "",
    INPUT_DIR: input,
    OUTPUT_DIR: output,
    PLAN_MATRIX_JSON: JSON.stringify(plan),
    QA_PROFILE: "all",
    TARGET_SHA: targetSha,
    PROTOCOL_BASE_SHA: protocolSha,
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    SHARD_COUNT: "2",
    GITHUB_OUTPUT: path.join(root, "github-output"),
    QA_EXIT_CODE: "",
    SHARD_JOB_OUTCOME: "failure",
    DOWNLOAD_OUTCOME: "success",
    AGGREGATE_OUTCOME: "failure",
    FINALIZE_OUTCOME: "skipped",
  };
  const status = (index = 0) => ({
    target: { sha: targetSha, protocolBaseSha: protocolSha },
    profile: "all",
    shard: plan.include[index],
    run: { id: "42", attempt: 1 },
    ...completion,
  });
  const writeShard = (index = 0, payload: unknown = status(index), artifactSha = targetSha) => {
    const directory =
      layout === "direct"
        ? input
        : path.join(input, `qa-profile-evidence-shard-${plan.include[index]!.id}-${artifactSha}`);
    put(path.join(directory, "qa-evidence.json"), '{"fixture":"unchanged"}\n');
    return put(
      path.join(directory, statusFile),
      typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`,
    );
  };
  const collect = (overrides: Partial<typeof env> = {}, sentinel = "") => {
    const run = spawnSync(process.execPath, [collectorPath], {
      cwd: root,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const text = fs.readFileSync(path.join(output, statusFile), "utf8");
    expect(fs.readdirSync(output)).toEqual([statusFile]);
    expect([...originals].map(([file]) => fs.readFileSync(file))).toEqual([...originals.values()]);
    for (const privateText of [root, sentinel].filter(Boolean)) {
      expect(text).not.toContain(privateText);
    }
    return { text, result: JSON.parse(text) };
  };
  return { root, input, output, env, status, put, writeShard, collect };
}

it("retains a direct survivor and leaves downloaded evidence untouched", () => {
  const f = fixture("direct");
  f.writeShard(1, { ...f.status(1), ...killed });
  f.put(path.join(f.input, "qa-suite-summary.json"), "unchanged report\n");
  const { result } = f.collect();
  expect(result.shards).toEqual([{ ...killed, id: "shard-02", source: "artifact-001" }]);
  expect(result).toMatchObject({ exitCode: null, timedOut: true, timeoutOutcome: "kill" });
  expect(result.diagnostics).toMatchObject({
    stages: { AGGREGATE_OUTCOME: "failure", FINALIZE_OUTCOME: "skipped" },
    statusFiles: 1,
    evidenceFiles: 1,
    missingStatuses: ["shard-01"],
    missingEvidence: ["shard-01"],
    issues: [],
  });
});

it.skipIf(windows)("rejects a direct status symlink", () => {
  const f = fixture("direct");
  fs.mkdirSync(f.input, { recursive: true });
  const target = path.join(f.root, "private-status.json");
  f.put(target, JSON.stringify({ ...f.status(), stderr: "private-status-sentinel" }));
  fs.symlinkSync(target, path.join(f.input, statusFile));
  const { result } = f.collect({}, "private-status-sentinel");
  expect(result.shards).toEqual([]);
  expect(result.diagnostics).toMatchObject({
    statusFiles: 0,
    missingStatuses: ["shard-01", "shard-02"],
  });
  expect(result.diagnostics.issues).toContainEqual({
    source: "artifact-001",
    reason: "missing-or-malformed-status",
  });
});

it("leaves missing downloads unknown", () => {
  const { result } = fixture().collect({
    DOWNLOAD_OUTCOME: "failure",
    AGGREGATE_OUTCOME: "skipped",
  });
  expect(result).toMatchObject({
    ...unknownOutcome,
    shards: [],
    diagnostics: {
      missingStatuses: ["shard-01", "shard-02"],
      missingEvidence: ["shard-01", "shard-02"],
      issues: [{ source: null, reason: "input-unavailable" }],
    },
  });
});

it.skipIf(windows)("requires the frozen harness SHA", () => {
  const f = fixture();
  const script = aggregateStep("Collect QA profile diagnostics");
  const head = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  for (const expected of ["", "not-a-sha", "f".repeat(40), head]) {
    const run = shell(script, repoRoot, { ...f.env, EXPECTED_WORKFLOW_SHA: expected });
    expect(run.status, run.stderr).toBe(expected === head ? 0 : 1);
    expect(fs.existsSync(path.join(f.output, statusFile))).toBe(expected === head);
  }
});

it.each(['{"untrusted-status-sentinel":', "x".repeat(65 * 1024)])(
  "bounds malformed status input %#",
  (payload) => {
    const f = fixture();
    f.writeShard(0, payload);
    const { text, result } = f.collect({}, "untrusted-status-sentinel");
    expect(result.shards).toEqual([]);
    expect(result.diagnostics.issues[0].reason).toBe(
      payload.length > 64 * 1024 ? "status-size-limit" : "missing-or-malformed-status",
    );
    expect(result.diagnostics.missingStatuses).toEqual(["shard-01", "shard-02"]);
    expect(Buffer.byteLength(text)).toBeLessThan(2048);
  },
);

it("redacts invalid identity, membership and outcome payloads", () => {
  const f = fixture();
  const privateText = "private-payload-sentinel:/operator/home?token=secret";
  f.writeShard();
  f.writeShard(0, f.status(), "c".repeat(40));
  f.writeShard(1, {
    ...f.status(1),
    profile: privateText,
    target: { sha: "d".repeat(40), protocolBaseSha: "e".repeat(40), ref: privateText },
    run: { id: "43", attempt: 2 },
    shard: { id: "shard-99", categoryIds: [privateText], scenarioIds: [{ toString: null }] },
    stderr: privateText,
    exitCode: privateText,
    timedOut: privateText,
    timeoutOutcome: privateText,
    completedAt: privateText,
  });
  const { result } = f.collect({}, privateText);
  expect(result.target).toEqual({ sha: targetSha, protocolBaseSha: protocolSha });
  expect(result.diagnostics).toMatchObject({
    duplicateStatuses: ["shard-01"],
    missingStatuses: ["shard-02"],
  });
  expect(result.shards.at(-1)).toMatchObject({ ...unknownOutcome, completedAt: null });
});

it("bounds the artifact inventory and produces deterministic output", () => {
  const f = fixture();
  for (let index = 0; index < 129; index += 1) {
    fs.mkdirSync(path.join(f.input, String(index)), { recursive: true });
  }
  const first = f.collect();
  const second = f.collect();
  expect(first.text).toBe(second.text);
  expect(first.result.shards).toEqual([]);
  expect(first.result.diagnostics.issues).toEqual([{ source: null, reason: "artifact-limit" }]);
  expect(Buffer.byteLength(first.text)).toBeLessThan(2048);
});

it.skipIf(windows)("never qualifies as maturity evidence", () => {
  const f = fixture();
  f.collect();
  const consumerDirectory = path.join(f.root, ".artifacts/maturity-evidence");
  fs.mkdirSync(consumerDirectory, { recursive: true });
  fs.copyFileSync(path.join(f.output, statusFile), path.join(consumerDirectory, statusFile));
  const script = workflowStep("maturity-scorecard.yml", "publish", "Require one QA evidence file");
  const run = shell(script, f.root, f.env);
  expect(run.status, run.stderr).toBe(1);
  expect(run.stderr).toContain("Expected exactly one aggregate QA evidence manifest, found 0");
});
