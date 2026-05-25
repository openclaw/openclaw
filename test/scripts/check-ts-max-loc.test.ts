import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectTsMaxLocCheck, writeLocBaseline } from "../../scripts/check-ts-max-loc.ts";
import { createScriptTestHarness } from "./test-helpers.ts";

const harness = createScriptTestHarness();

function writeRepoFile(repoRoot: string, relativePath: string, value: string): void {
  const filePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

function makeRepo(): string {
  const repoRoot = harness.createTempDir("openclaw-loc-check-");
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  return repoRoot;
}

describe("check-ts-max-loc", () => {
  it("flags new oversized TypeScript files without a baseline entry", async () => {
    const repoRoot = makeRepo();
    writeRepoFile(repoRoot, "src/new.ts", "one\ntwo\nthree\n");

    const result = await collectTsMaxLocCheck({ maxLines: 2, rootDir: repoRoot });

    expect(result.ok).toBe(false);
    expect(result.newOffenders).toEqual([{ filePath: "src/new.ts", lines: 4 }]);
  });

  it("allows existing oversized debt when it is at or below the baseline", async () => {
    const repoRoot = makeRepo();
    writeRepoFile(repoRoot, "src/old.ts", "one\ntwo\nthree\n");
    writeRepoFile(
      repoRoot,
      "scripts/lib/ts-max-loc-baseline.json",
      JSON.stringify({ entries: { "src/old.ts": { lines: 4, category: "core-runtime" } } }),
    );

    const result = await collectTsMaxLocCheck({
      baselinePath: path.join(repoRoot, "scripts/lib/ts-max-loc-baseline.json"),
      maxLines: 2,
      rootDir: repoRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.baselinedDebtCount).toBe(1);
  });

  it("fails when an oversized file grows beyond its baseline", async () => {
    const repoRoot = makeRepo();
    writeRepoFile(repoRoot, "src/old.ts", "one\ntwo\nthree\n");
    writeRepoFile(
      repoRoot,
      "scripts/lib/ts-max-loc-baseline.json",
      JSON.stringify({ entries: { "src/old.ts": { lines: 3, category: "core-runtime" } } }),
    );

    const result = await collectTsMaxLocCheck({
      baselinePath: path.join(repoRoot, "scripts/lib/ts-max-loc-baseline.json"),
      maxLines: 2,
      rootDir: repoRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.grownOffenders).toEqual([
      { baselineLines: 3, category: "core-runtime", filePath: "src/old.ts", lines: 4 },
    ]);
  });

  it("fails stale baseline entries after a file drops under the max", async () => {
    const repoRoot = makeRepo();
    writeRepoFile(repoRoot, "src/old.ts", "one\n");
    writeRepoFile(
      repoRoot,
      "scripts/lib/ts-max-loc-baseline.json",
      JSON.stringify({ entries: { "src/old.ts": { lines: 4, category: "core-runtime" } } }),
    );

    const result = await collectTsMaxLocCheck({
      baselinePath: path.join(repoRoot, "scripts/lib/ts-max-loc-baseline.json"),
      maxLines: 2,
      rootDir: repoRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.staleBaselineEntries).toEqual([
      { filePath: "src/old.ts", reason: "file is now at or below the LOC max" },
    ]);
  });

  it("writes a compact numeric baseline to keep governance diffs reviewable", async () => {
    const repoRoot = makeRepo();
    const baselinePath = path.join(repoRoot, "scripts/lib/ts-max-loc-baseline.json");

    await writeLocBaseline({
      baselinePath,
      maxLines: 2,
      offenders: [
        { filePath: "src/small.ts", lines: 3 },
        { filePath: "src/large.ts", lines: 10 },
      ],
    });

    const raw = readFileSync(baselinePath, "utf8");
    expect(raw.split("\n")).toHaveLength(2);
    expect(JSON.parse(raw).entries).toEqual({
      "src/large.ts": 10,
      "src/small.ts": 3,
    });
  });
});
