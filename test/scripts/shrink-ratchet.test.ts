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
    const { root } = gitRepo("openclaw-ratchet-unavailable-");
    expect(() =>
      ratchet.resolveRatchetBase(root, { base: "missing", staged: false, mergeBase: false }),
    ).toThrow(/Could not resolve ratchet base ref/u);
  });

  it("rejects missing paths whose names resemble successful batch headers", () => {
    const { root } = gitRepo("openclaw-shrink-ratchet-missing-");
    expect(() => ratchet.loadRatchetSources(root, ["src/missing.ts"])).toThrow(
      /Could not read staged source/u,
    );
    expect(() => ratchet.loadRatchetSources(root, ["src/missing blob 0\n\n.ts"])).toThrow(
      /Could not read staged source/u,
    );
  });

  type BaselineCase = {
    file: string;
    source: string;
    expected: unknown;
    parse: (source: string) => unknown;
  };
  it.each`
    file            | source                                           | expected                              | parse
    ${"paths.txt"}  | ${"# grandfathered files\nsrc/b.ts\nsrc/a.ts\n"} | ${["src/b.ts", "src/a.ts"]}           | ${(source: string) => [...ratchet.parseRatchetPaths(source)]}
    ${"counts.txt"} | ${"# per-file debt\nsrc/b.ts\t2\nsrc/a.ts\t1\n"} | ${[["src/b.ts", 2], ["src/a.ts", 1]]} | ${(source: string) => [...ratchet.parseRatchetCounts(source, "counts.txt")]}
  `(
    "loads the existing $file baseline format",
    ({ file, source, expected, parse }: BaselineCase) => {
      const root = tempDirs.make("openclaw-shrink-ratchet-");
      fs.writeFileSync(path.join(root, file), source);
      expect(ratchet.loadRatchetSnapshot<unknown>(root, file, false, parse)).toEqual(expected);
    },
  );

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
    expect(
      ratchet.compareRatchetSets(
        ["src/z.ts", "src/b.ts", "src/c.ts", "src/y.ts"],
        new Set(["src/x.ts", "src/a.ts", "src/b.ts", "src/w.ts"]),
      ),
    ).toEqual({
      added: ["src/c.ts", "src/y.ts", "src/z.ts"],
      removed: ["src/a.ts", "src/w.ts", "src/x.ts"],
    });
  });

  it("compares per-entry counts without permitting growth", () => {
    expect(
      ratchet.compareRatchetCounts(
        new Map(Object.entries({ "src/z.ts": 1, "src/b.ts": 1, "src/c.ts": 1 })),
        new Map(Object.entries({ "src/x.ts": 1, "src/a.ts": 1, "src/b.ts": 2 })),
      ),
    ).toEqual({
      decreased: [
        { allowed: 1, current: 0, entry: "src/a.ts" },
        { allowed: 2, current: 1, entry: "src/b.ts" },
        { allowed: 1, current: 0, entry: "src/x.ts" },
      ],
      increased: [
        { allowed: 0, current: 1, entry: "src/c.ts" },
        { allowed: 0, current: 1, entry: "src/z.ts" },
      ],
    });
  });
});
