import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareLineCapViolations, main } from "../../scripts/check-line-cap-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function git(root: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function source(lines: number) {
  return (
    Array.from({ length: lines }, (_, index) => `export const value${index} = ${index};`).join(
      "\n",
    ) + "\n"
  );
}

function fixture(lines = 5, severity = "warn") {
  const root = tempDirs.make("openclaw-line-cap-test-");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, ".oxlintrc.json"),
    JSON.stringify({
      overrides: [
        {
          files: ["src/**/*.ts"],
          excludeFiles: ["**/generated/**"],
          rules: {
            "max-lines": [severity, { max: 3, skipBlankLines: true, skipComments: true }],
          },
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(root, "src/file.ts"), source(lines));
  git(root, "init");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return root;
}

describe("line-cap growth ratchet", () => {
  it.each([
    { label: "over-cap shrinking", before: 705, after: 703, fails: false },
    { label: "over-cap growing", before: 705, after: 706, fails: true },
    { label: "newly over-cap", before: 700, after: 701, fails: true },
    { label: "under-cap growth", before: 698, after: 700, fails: false },
    { label: "unchanged over-cap", before: 705, after: 705, fails: false },
  ])("$label", ({ before, after, fails }) => {
    const violations = (count: number) =>
      new Map(count > 700 ? [["src/file.ts", { count, cap: 700 }]] : []);
    expect(compareLineCapViolations(violations(after), violations(before)).length > 0).toBe(fails);
  });

  it("carries the old path's count across a rename", () => {
    expect(
      compareLineCapViolations(
        new Map([["src/renamed.ts", { count: 703, cap: 700 }]]),
        new Map([["src/original.ts", { count: 705, cap: 700 }]]),
        [{ from: "src/original.ts", to: "src/renamed.ts" }],
      ),
    ).toEqual([]);
  });

  it.each(["warn", "error"])(
    "ratchets %s diagnostics across renames, staged and untracked sources",
    (severity) => {
      const root = fixture(5, severity);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      git(root, "mv", "src/file.ts", "src/renamed.ts");
      fs.writeFileSync(
        path.join(root, "src/renamed.ts"),
        source(4) + "\n/* comment\n comment */\n",
      );
      expect(main(root, ["--base", "HEAD"])).toBe(0);
      fs.writeFileSync(path.join(root, "src/renamed.ts"), source(6));
      git(root, "add", ".");
      fs.writeFileSync(path.join(root, "src/renamed.ts"), source(4));
      expect(main(root, ["--base", "HEAD", "--staged"])).toBe(1);
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining("src/renamed.ts: 5 -> 6 counted lines (cap 3)"),
      );
      expect(main(root, ["--base", "HEAD"])).toBe(0);
      fs.mkdirSync(path.join(root, "src/generated"));
      fs.writeFileSync(path.join(root, "src/generated/ignored.ts"), source(10));
      expect(main(root, ["--base", "HEAD"])).toBe(0);
      fs.writeFileSync(path.join(root, "src/new.ts"), source(4));
      expect(main(root, ["--base", "HEAD"])).toBe(1);
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining("src/new.ts: 3 -> 4 counted lines (cap 3)"),
      );
    },
  );

  it("compares a PR merge tree with its prepared base without blaming unrelated debt", () => {
    const root = fixture(2);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    git(root, "branch", "feature");
    fs.writeFileSync(path.join(root, "src/other.ts"), source(8));
    git(root, "add", ".");
    git(root, "commit", "-m", "main accumulated debt");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "feature");
    fs.writeFileSync(path.join(root, "src/file.ts"), source(3));
    git(root, "add", ".");
    git(root, "commit", "-m", "under-cap growth");
    git(root, "merge", "--no-ff", base, "-m", "PR merge tree");
    expect(main(root, ["--base", base])).toBe(0);
  });

  it.each(["oxlint", "eslint"])("counts %s-suppressed debt without changing the source", (tool) => {
    const root = fixture();
    const target = path.join(root, "src/file.ts");
    const directive = `/* ${tool}-disable max-lines -- inherited debt */\n`;
    fs.writeFileSync(target, directive + source(5));
    git(root, "add", ".");
    git(root, "commit", "-m", "inherited suppression");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    fs.writeFileSync(target, directive + source(4));
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    const growing = directive + source(6);
    fs.writeFileSync(target, growing);
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("src/file.ts: 5 -> 6 counted lines (cap 3)"),
    );
    expect(fs.readFileSync(target, "utf8")).toBe(growing);
  });
});
