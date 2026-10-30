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

function commit(root: string, message: string, files: Record<string, string>): string {
  for (const [path, value] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value, "utf8");
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function audit(root: string, bounds: Record<string, string> = {}, separator = false) {
  const args = Object.entries(bounds).flatMap(([name, value]) => [`--${name}`, value]);
  return spawnSync(process.execPath, [script, ...(separator ? ["--"] : []), ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
}

function fixture() {
  const root = tempDirs.make("release-backport-companions-");
  git(root, ["init", "-q", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["config", "user.email", "release-test@example.com"]);
  const baseline = commit(root, "baseline", {
    "src/metrics.ts": "baseline\n",
    "scripts/registry.mjs": "baseline\n",
  });
  const selected = commit(root, "fix: add Prometheus IPC producer (#101)", {
    "src/metrics.ts": "selected\n",
    "scripts/prometheus-ipc-producer.mjs": "selected\n",
  });
  const samePathFollowup = commit(root, "fix: register Prometheus IPC producer (#102)", {
    "scripts/registry.mjs": 'import "./prometheus-ipc-producer.mjs";\n',
    "src/metrics.ts": "registered\n",
  });
  const prMentionFollowup = commit(root, "test: cover the #101 producer contract", {
    "test/metrics.test.ts": 'import "../src/metrics.js";\n',
  });
  git(root, ["switch", "-q", "-c", "candidate", baseline]);
  const candidate = commit(root, "prepare candidate with incomplete selected file set", {
    "src/metrics.ts": "adapted\n",
    "release-note.md": "candidate-only resolution\n",
  });

  return { baseline, candidate, prMentionFollowup, root, samePathFollowup, selected };
}

describe("release-backport-companions", () => {
  it("accepts the package-manager separator and finds companion gaps", () => {
    const repo = fixture();
    const result = audit(
      repo.root,
      {
        baseline: repo.baseline,
        candidate: repo.candidate,
        "scan-end": repo.prMentionFollowup,
        selected: repo.selected,
      },
      true,
    );
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);

    expect(report.selection[0].laterSamePath).toContainEqual(
      expect.objectContaining({ sha: repo.samePathFollowup, paths: ["src/metrics.ts"] }),
    );
    expect(report.selection[0].laterPrMentions).toContainEqual(
      expect.objectContaining({ sha: repo.prMentionFollowup }),
    );
    expect(report.companions).toMatchObject({
      neighborTests: expect.arrayContaining([
        { path: "test/metrics.test.ts", reason: "neighbor-test", selected: false },
      ]),
      referenceCandidates: expect.arrayContaining([
        { path: "scripts/registry.mjs", reason: "selected-file-reference", selected: false },
      ]),
    });
    expect(report.comparison.missingSelectedPaths).toEqual(["scripts/prometheus-ipc-producer.mjs"]);
    const metricsDifference = report.comparison.contentDifferences.find(
      (item: { path: string }) => item.path === "src/metrics.ts",
    );
    expect(metricsDifference).toMatchObject({ path: "src/metrics.ts", selectedSha: repo.selected });
    expect(metricsDifference.candidateObject).not.toBe(metricsDifference.object);
    expect(report.comparison.extraCandidatePaths).toEqual(["release-note.md"]);
  });

  it("rejects a selected commit already included in the pinned baseline", () => {
    const repo = fixture();
    const result = audit(repo.root, {
      baseline: repo.selected,
      "scan-end": repo.prMentionFollowup,
      selected: repo.selected,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already reachable from the pinned baseline");
  });

  it("requires pinned audit bounds and a selected commit", () => {
    const root = tempDirs.make("release-backport-companions-args-");
    const result = audit(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: release-backport-companions");
  });
});
