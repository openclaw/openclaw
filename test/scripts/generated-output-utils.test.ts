import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeGeneratedOutput } from "../../scripts/lib/generated-output-utils.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(
  [true, false].flatMap((check) =>
    (["equal", "stale", "missing"] as const).map((state) => ({ check, state })),
  ),
)("reports and persists exact output for $state, check=$check", ({ check, state }) => {
  const repoRoot = tempDirs.make("generated-output-");
  const outputPath = path.join(repoRoot, "nested", "generated.txt");
  const next = "snow雪\n";
  if (state !== "missing") {
    fs.mkdirSync(path.dirname(outputPath));
    fs.writeFileSync(outputPath, state === "equal" ? next : "old");
  }
  const result = writeGeneratedOutput({
    repoRoot,
    outputPath: "nested/generated.txt",
    next,
    check,
  });
  const changed = state !== "equal";
  expect(result).toEqual({ changed, wrote: !check && changed, outputPath });
  if (check && state === "missing") {
    expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
  } else {
    expect(fs.readFileSync(outputPath, "utf8")).toBe(check && state === "stale" ? "old" : next);
  }
});

it.each([true, false])("preserves empty output, check=%s", (check) => {
  const repoRoot = tempDirs.make("generated-empty-");
  const outputPath = path.join(repoRoot, "empty.txt");
  fs.writeFileSync(outputPath, "");
  expect(writeGeneratedOutput({ repoRoot, outputPath, next: "", check })).toEqual({
    changed: false,
    wrote: false,
    outputPath,
  });
  expect(fs.readFileSync(outputPath, "utf8")).toBe("");
});

it.each([true, false])("reads each existing output once, check=%s", (check) => {
  const repoRoot = tempDirs.make("generated-reads-");
  const outputPath = path.join(repoRoot, "generated.txt");
  fs.writeFileSync(outputPath, "old");
  const read = vi.spyOn(fs, "readFileSync");
  const result = writeGeneratedOutput({ repoRoot, outputPath, next: "next", check });
  expect(result).toEqual({ changed: true, wrote: !check, outputPath });
  expect(read.mock.calls.filter(([file]) => file === outputPath)).toHaveLength(1);
});

it("leaves unchanged metadata intact and preserves executable mode on replacement", () => {
  const repoRoot = tempDirs.make("generated-metadata-");
  const outputPath = path.join(repoRoot, "generated.txt");
  fs.writeFileSync(outputPath, "same");
  fs.chmodSync(outputPath, 0o755);
  const timestamp = new Date("2000-01-01T00:00:00Z");
  fs.utimesSync(outputPath, timestamp, timestamp);
  const before = fs.statSync(outputPath);
  expect(writeGeneratedOutput({ repoRoot, outputPath, next: "same", check: false }).wrote).toBe(
    false,
  );
  const after = fs.statSync(outputPath);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.ino).toBe(before.ino);
  expect(after.mode).toBe(before.mode);
  expect(writeGeneratedOutput({ repoRoot, outputPath, next: "next", check: false }).wrote).toBe(
    true,
  );
  expect(fs.readFileSync(outputPath, "utf8")).toBe("next");
  expect(fs.statSync(outputPath).mode).toBe(before.mode);
});

it("keeps check mode read-only and propagates a real blocked-parent write error", () => {
  const repoRoot = tempDirs.make("generated-blocked-");
  fs.writeFileSync(path.join(repoRoot, "blocked"), "sentinel");
  const outputPath = path.join(repoRoot, "blocked", "generated.txt");
  expect(writeGeneratedOutput({ repoRoot, outputPath, next: "next", check: true })).toEqual({
    changed: true,
    wrote: false,
    outputPath,
  });
  expect(() =>
    writeGeneratedOutput({ repoRoot, outputPath, next: "next", check: false }),
  ).toThrow();
  expect(fs.readFileSync(path.join(repoRoot, "blocked"), "utf8")).toBe("sentinel");
});
