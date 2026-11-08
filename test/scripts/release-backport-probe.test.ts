import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatBackportProbes, probeBackport } from "../../scripts/release-backport-probe.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const SCRIPT = path.resolve("scripts/release-backport-probe.mjs");

function git(root: string, args: string[]): string {
  return childProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, file: string, contents: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function commit(root: string, message: string): string {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function fixture() {
  const root = createTempDir("release-backport-probe-");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "OpenClaw Test"]);
  git(root, ["config", "user.email", "test@openclaw.invalid"]);
  write(root, "shared.txt", "base\n");
  const base = commit(root, "base");

  git(root, ["checkout", "-q", "-b", "main", base]);
  write(root, "clean.txt", "candidate\n");
  const clean = commit(root, "clean candidate");

  write(root, "shared.txt", "candidate\n");
  const conflicted = commit(root, "conflicting candidate");

  write(root, "covered.txt", "same patch\n");
  const covered = commit(root, "covered candidate");
  write(root, "scan-end.txt", "pinned main\n");
  const scanEnd = commit(root, "scan end");

  git(root, ["checkout", "-q", "-b", "unreachable", base]);
  write(root, "unreachable.txt", "not on pinned main\n");
  const unreachable = commit(root, "unreachable candidate");

  git(root, ["checkout", "-q", "-b", "baseline", base]);
  write(root, "shared.txt", "baseline\n");
  write(root, "covered.txt", "same patch\n");
  write(root, "baseline.txt", "release line\n");
  const baseline = commit(root, "release baseline");
  return { baseline, clean, conflicted, covered, root, scanEnd, unreachable };
}

describe("release backport tree probe", () => {
  it("classifies clean, conflicted, and already-covered patches without a worktree", () => {
    const f = fixture();
    const probes = [f.clean, f.conflicted, f.covered].map((candidate) =>
      probeBackport({ baseline: f.baseline, candidate, cwd: f.root, scanEnd: f.scanEnd }),
    );

    expect(
      probes.map(({ patchStatus, qualification, conflictCount, touchedFileCount }) => ({
        patchStatus,
        qualification,
        conflictCount,
        touchedFileCount,
      })),
    ).toEqual([
      {
        patchStatus: "clean",
        qualification: "contract-review-required",
        conflictCount: 0,
        touchedFileCount: 1,
      },
      {
        patchStatus: "conflicted",
        qualification: "contract-review-required",
        conflictCount: 1,
        touchedFileCount: 1,
      },
      {
        patchStatus: "already-covered",
        qualification: "contract-review-required",
        conflictCount: 0,
        touchedFileCount: 1,
      },
    ]);
    expect(probes[1]?.conflicts).toEqual(new Set(["shared.txt"]));
    expect(formatBackportProbes(probes)).toContain(
      `${f.conflicted}\t${f.baseline}\t${f.scanEnd}\t1\tcontract-review-required\tconflicted`,
    );
  });

  it("rejects a candidate that is not reachable from the pinned scan end", () => {
    const f = fixture();

    expect(() =>
      probeBackport({
        baseline: f.baseline,
        candidate: f.unreachable,
        cwd: f.root,
        scanEnd: f.scanEnd,
      }),
    ).toThrow(`Candidate ${f.unreachable} is not reachable from scan end ${f.scanEnd}`);
  });

  it("prints one stable TSV report for multiple candidates", () => {
    const f = fixture();
    const result = childProcess.spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--",
        "--baseline",
        f.baseline,
        "--scan-end",
        f.scanEnd,
        "--candidate",
        f.clean,
        "--candidate",
        f.conflicted,
      ],
      { cwd: f.root, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe(
      "candidate\tbaseline\tscan_end\tscan_reachable\tqualification\tpatch_status\tconflict_count\ttouched_file_count\ttouched_file\tconflict",
    );
    expect(result.stdout).toContain(
      `${f.clean}\t${f.baseline}\t${f.scanEnd}\t1\tcontract-review-required\tclean`,
    );
    expect(result.stdout).toContain(
      `${f.conflicted}\t${f.baseline}\t${f.scanEnd}\t1\tcontract-review-required\tconflicted\t1\t1\tshared.txt\t1`,
    );
  });
});
