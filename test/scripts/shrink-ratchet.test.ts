import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as ratchet from "../../scripts/lib/shrink-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function gitRepo(prefix: string) {
  const root = tempDirs.make(prefix);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  return { root, git };
}

describe("shrink-ratchet", () => {
  it("requires an explicit base when the caller supplies prepared ancestry", () => {
    expect(() => ratchet.parseRatchetArgs(["--no-merge-base"])).toThrow(/requires --base/u);
    expect(ratchet.parseRatchetArgs(["--base", "HEAD", "--no-merge-base"])).toMatchObject({
      base: "HEAD",
      mergeBase: false,
    });
    expect(ratchet.parseRatchetArgs(["--base", "HEAD"]).mergeBase).toBe(true);
  });

  it("rejects missing paths whose names resemble successful batch headers", () => {
    const { root } = gitRepo("openclaw-shrink-ratchet-missing-");
    expect(() => ratchet.loadRatchetSources(root, ["src/missing blob 0\n\n.ts"])).toThrow(
      /Could not read staged source/u,
    );
  });

  it("parses commented path baselines without sorting them", () => {
    expect([...ratchet.parseRatchetPaths("# baseline\nsrc/b.ts\nsrc/a.ts\n")]).toEqual([
      "src/b.ts",
      "src/a.ts",
    ]);
  });

  it("parses commented count baselines without sorting them", () => {
    expect([...ratchet.parseRatchetCounts("# baseline\nb\t2\na\t1\n", "counts.txt")]).toEqual([
      ["b", 2],
      ["a", 1],
    ]);
  });

  it("loads worktree, index, and reference snapshots beyond the Git pipe limit", () => {
    const { root, git } = gitRepo("openclaw-shrink-ratchet-git-");
    const baselinePath = "baseline.txt";
    const absolutePath = path.join(root, baselinePath);
    const padding = `#${"x".repeat(2 * 1024 * 1024)}\n`;
    fs.writeFileSync(absolutePath, padding + "1\n");
    git("add", baselinePath);
    git("-c", "user.name=OpenClaw", "-c", "user.email=test@openclaw.local", "commit", "-m", "base");
    fs.writeFileSync(absolutePath, padding + "2\n");
    git("add", baselinePath);
    fs.writeFileSync(absolutePath, padding + "3\n");
    const parse = (source: string) => ratchet.parseRatchetScalar(source, baselinePath);

    expect(ratchet.loadRatchetSnapshot(root, baselinePath, false, parse)).toBe(3);
    expect(ratchet.loadRatchetSnapshot(root, baselinePath, true, parse)).toBe(2);
    expect(ratchet.loadRatchetReference(root, "HEAD", baselinePath, parse)).toBe(1);
    expect(ratchet.loadRatchetReference(root, "HEAD", "missing.txt", parse)).toBeNull();
    expect(() => ratchet.loadRatchetReference(root, "missing-ref", baselinePath, parse)).toThrow();
  });

  it.each`
    name                  | parse                                                                           | error
    ${"duplicate counts"} | ${() => ratchet.parseRatchetCounts("src/a.ts\t1\nsrc/a.ts\t2\n", "counts.txt")} | ${/Invalid counts\.txt entry/u}
    ${"negative scalars"} | ${() => ratchet.parseRatchetScalar("-1\n", "scalar.txt")}                       | ${/exactly one non-negative integer/u}
  `("rejects $name", ({ parse, error }: { parse: () => unknown; error: RegExp }) =>
    expect(parse).toThrow(error),
  );

  it("compares path sets without permitting growth", () => {
    expect(ratchet.compareRatchetSets(["z", "b", "c"], new Set(["x", "a", "b"]))).toEqual({
      added: ["c", "z"],
      removed: ["a", "x"],
    });
  });
});
