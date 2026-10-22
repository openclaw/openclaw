import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = join(process.cwd(), "scripts/release-backport-companions.mjs");

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function write(root: string, path: string, value: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value, "utf8");
}

function commit(root: string, message: string): string {
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release-test@example.com",
    "commit",
    "-qm",
    message,
  ]);
  return git(root, ["rev-parse", "HEAD"]);
}

function fixture() {
  const root = tempDirs.make("release-backport-companions-");
  git(root, ["init", "-q", "--initial-branch=main"]);
  write(root, "src/metrics.ts", "export const metrics = true;\n");
  write(root, "scripts/registry.mjs", "export const producers = [];\n");
  const baseline = commit(root, "baseline");

  write(root, "src/metrics.ts", "export const metrics = { ipc: true };\n");
  write(root, "scripts/prometheus-ipc-producer.mjs", "export const producer = true;\n");
  const selected = commit(root, "fix: add Prometheus IPC producer (#101)");

  write(
    root,
    "scripts/registry.mjs",
    'import "./prometheus-ipc-producer.mjs";\nexport const producers = ["ipc"];\n',
  );
  write(root, "src/metrics.ts", "export const metrics = { ipc: true, registered: true };\n");
  const samePathFollowup = commit(root, "fix: register Prometheus IPC producer (#102)");

  write(
    root,
    "test/metrics.test.ts",
    'import { metrics } from "../src/metrics.js";\nvoid metrics;\n',
  );
  const prMentionFollowup = commit(root, "test: cover the #101 producer contract");
  const scanEnd = git(root, ["rev-parse", "HEAD"]);

  git(root, ["switch", "-q", "-c", "candidate", baseline]);
  write(root, "src/metrics.ts", 'export const metrics = { ipc: "adapted" };\n');
  write(root, "release-note.md", "candidate-only resolution\n");
  const candidate = commit(root, "prepare candidate with incomplete selected file set");

  return { baseline, candidate, prMentionFollowup, root, samePathFollowup, scanEnd, selected };
}

describe("release-backport-companions", () => {
  it("accepts the package-manager separator and finds companion gaps", () => {
    const repo = fixture();
    const output = execFileSync(
      process.execPath,
      [
        script,
        "--",
        "--baseline",
        repo.baseline,
        "--candidate",
        repo.candidate,
        "--scan-end",
        repo.scanEnd,
        "--selected",
        repo.selected,
        "--json",
      ],
      { cwd: repo.root, encoding: "utf8" },
    );
    const report = JSON.parse(output);

    expect(report.schema).toBe("openclaw.release-backport-companions.v1");
    expect(report.selection[0].laterSamePath).toContainEqual(
      expect.objectContaining({ sha: repo.samePathFollowup, paths: ["src/metrics.ts"] }),
    );
    expect(report.selection[0].laterPrMentions).toContainEqual(
      expect.objectContaining({ sha: repo.prMentionFollowup }),
    );
    expect(report.companions.neighborTests).toContainEqual({
      path: "test/metrics.test.ts",
      reason: "neighbor-test",
      selected: false,
    });
    expect(report.companions.referenceCandidates).toContainEqual({
      path: "scripts/registry.mjs",
      reason: "selected-file-reference",
      selected: false,
    });
    expect(report.comparison.missingSelectedPaths).toEqual(["scripts/prometheus-ipc-producer.mjs"]);
    const metricsDifference = report.comparison.contentDifferences.find(
      (item: { path: string }) => item.path === "src/metrics.ts",
    );
    expect(metricsDifference).toEqual(
      expect.objectContaining({ path: "src/metrics.ts", selectedSha: repo.selected }),
    );
    expect(metricsDifference.candidateObject).not.toBe(metricsDifference.object);
    expect(report.comparison.extraCandidatePaths).toEqual(["release-note.md"]);
  });

  it("rejects a selected commit already included in the pinned baseline", () => {
    const repo = fixture();
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--baseline",
        repo.selected,
        "--scan-end",
        repo.scanEnd,
        "--selected",
        repo.selected,
        "--json",
      ],
      { cwd: repo.root, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already reachable from the pinned baseline");
  });

  it("requires pinned audit bounds and a selected commit", () => {
    const root = tempDirs.make("release-backport-companions-args-");
    const result = spawnSync(process.execPath, [script, "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: release-backport-companions");
  });
});
