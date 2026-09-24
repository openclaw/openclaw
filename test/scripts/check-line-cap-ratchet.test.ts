import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareLineCapViolations, main } from "../../scripts/check-line-cap-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => vi.stubEnv("GITHUB_ACTIONS", ""));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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

function fixture(lines = 5, severity = "warn", ignorePatterns: string[] = []) {
  const root = tempDirs.make("openclaw-line-cap-test-");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, ".oxlintrc.json"),
    JSON.stringify({
      ignorePatterns,
      overrides: [
        {
          files: ["**/*.ts"],
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
  it("warns for CI growth, writes the summary, and still rejects broken source", () => {
    const root = fixture();
    const summary = path.join(root, "summary.md");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    fs.writeFileSync(path.join(root, "src/file.ts"), source(6));
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("::warning file=src/file.ts,line=1,col=0,"),
    );
    expect(fs.readFileSync(summary, "utf8")).toContain("5 -&gt; 6 counted lines");
    fs.writeFileSync(path.join(root, "src/file.ts"), "export const = broken;");
    expect(main(root, ["--base", "HEAD"])).toBe(1);
  });

  it("measures ignored repository-contained scratch while preserving explicit exclusions", () => {
    const root = fixture(5, "warn", ["src/ignored/**"]);
    fs.writeFileSync(path.join(root, ".gitignore"), ".artifacts/\n");
    const scratch = path.join(root, ".artifacts", "scratch");
    fs.mkdirSync(scratch, { recursive: true });
    vi.stubEnv("TMPDIR", scratch);
    vi.stubEnv("TMP", scratch);
    vi.stubEnv("TEMP", scratch);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const target = path.join(root, "src/file.ts");
    fs.writeFileSync(target, source(6));
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("src/file.ts: 5 -> 6 counted lines (cap 3)"),
    );
    fs.writeFileSync(target, source(4));
    for (const directory of ["ignored", "generated"]) {
      fs.mkdirSync(path.join(root, "src", directory));
      fs.writeFileSync(path.join(root, "src", directory, "excluded.ts"), source(8));
    }
    errors.mockClear();
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

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

  it.skipIf(process.platform === "win32")("preserves native filenames beginning with file:", () => {
    vi.stubEnv("TERMINAL_EMULATOR", "");
    const root = fixture();
    vi.spyOn(console, "log").mockImplementation(() => {});
    git(root, "mv", "src/file.ts", "file:ordinary.ts");
    fs.writeFileSync(path.join(root, "file:ordinary.ts"), source(4));
    expect(main(root, ["--base", "HEAD"])).toBe(0);
  });

  it.each([
    { severity: "warn", terminal: "" },
    { severity: "error", terminal: "JetBrains-JediTerm" },
  ])(
    "ratchets $severity diagnostics in terminal '$terminal' across renames, staged and untracked sources",
    ({ severity, terminal }) => {
      vi.stubEnv("TERMINAL_EMULATOR", terminal);
      const root = fixture(5, severity);
      const scratch = tempDirs.make("openclaw-line-cap-scratch-");
      const scratchAlias = path.join(root, "scratch-alias");
      fs.symlinkSync(scratch, scratchAlias, process.platform === "win32" ? "junction" : "dir");
      vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", scratchAlias);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      fs.writeFileSync(path.join(root, "src/file.ts"), source(5) + "// changed comment\n");
      expect(main(root, ["--base", "HEAD"])).toBe(0);
      const renamed = "src/renamed space #%.ts";
      git(root, "mv", "src/file.ts", renamed);
      fs.writeFileSync(path.join(root, renamed), source(4) + "\n/* comment\n comment */\n");
      expect(main(root, ["--base", "HEAD"])).toBe(0);
      fs.writeFileSync(path.join(root, renamed), source(6));
      git(root, "add", ".");
      fs.writeFileSync(path.join(root, renamed), source(4));
      expect(main(root, ["--base", "HEAD", "--staged"])).toBe(1);
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining(`${renamed}: 5 -> 6 counted lines (cap 3)`),
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

  it.each([
    {
      label: "repaired under-cap head",
      invalidBase: true,
      invalidHead: false,
      lines: 3,
      result: 0,
    },
    {
      label: "over-cap head with unmeasurable debt",
      invalidBase: true,
      invalidHead: false,
      lines: 4,
      result: 1,
    },
    { label: "malformed head", invalidBase: false, invalidHead: true, lines: 2, result: 1 },
  ])(
    "handles $label without relaxing the head check",
    ({ invalidBase, invalidHead, lines, result }) => {
      const root = fixture(2);
      const target = path.join(root, "src/file.ts");
      const broken = "const duplicate = 1;\nconst duplicate = 2;\n";
      if (invalidBase) {
        fs.writeFileSync(target, broken);
        git(root, "add", ".");
        git(root, "commit", "-m", "broken base");
      }
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      fs.writeFileSync(target, invalidHead ? broken : source(lines));
      expect(main(root, ["--base", "HEAD"])).toBe(result);
      if (result === 0) {
        expect(errors).not.toHaveBeenCalled();
      } else {
        expect(errors).toHaveBeenCalledWith(expect.stringContaining("Cannot measure src/file.ts:"));
      }
    },
  );

  it("measures inherited debt only for head files that exceed their cap", () => {
    const root = fixture(5);
    const repaired = path.join(root, "src/repaired.ts");
    fs.writeFileSync(repaired, "const duplicate = 1;\nconst duplicate = 2;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "broken sibling");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(path.join(root, "src/file.ts"), source(4));
    fs.writeFileSync(repaired, source(2));
    expect(main(root, ["--base", "HEAD"])).toBe(0);
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
