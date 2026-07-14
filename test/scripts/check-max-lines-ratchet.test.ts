import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectCurrentSuppressions,
  diffBaseline,
  findBaselineExpansion,
  hasMaxLinesDisable,
  isGovernedSourcePath,
  main,
  parseBaseline,
} from "../../scripts/check-max-lines-ratchet.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("check-max-lines-ratchet", () => {
  it("recognizes suppressions without matching reason prose", () => {
    expect(hasMaxLinesDisable("/* oxlint-disable max-lines -- TODO: split. */\n")).toBe(true);
    expect(hasMaxLinesDisable("// eslint-disable-next-line no-console, max-lines\n")).toBe(true);
    expect(hasMaxLinesDisable("/* oxlint-disable */\n")).toBe(true);
    expect(hasMaxLinesDisable("// oxlint-disable-line -- all rules\n")).toBe(true);
    expect(hasMaxLinesDisable("/* oxlint-disable max-lines - TODO: split. */\n")).toBe(true);
    expect(hasMaxLinesDisable("/* oxlint-disable max-lines--temporary */\n")).toBe(true);
    expect(hasMaxLinesDisable("/* oxlint-disable - all rules */\n")).toBe(false);
    expect(hasMaxLinesDisable("/* oxlint-disable eslint/max-lines */\n")).toBe(true);
    expect(hasMaxLinesDisable("/* oxlint-disable\nmax-lines\n-- TODO: split. */\n")).toBe(true);
    expect(hasMaxLinesDisable("/* oxlint-disable no-console -- mentions max-lines */\n")).toBe(
      false,
    );
    expect(hasMaxLinesDisable("// Example: oxlint-disable max-lines\n")).toBe(false);
    expect(hasMaxLinesDisable('const example = "/* oxlint-disable max-lines */";\n')).toBe(false);
  });

  it("limits source roots and excludes generated output", () => {
    expect(isGovernedSourcePath("src/runtime.ts")).toBe(true);
    expect(isGovernedSourcePath("extensions/demo/index.mjs")).toBe(true);
    expect(isGovernedSourcePath("scripts/tool.mjs")).toBe(false);
    expect(isGovernedSourcePath("packages/api/protocol-gen/types.ts")).toBe(false);
    expect(isGovernedSourcePath("ui/src/i18n/locales/en.ts")).toBe(false);
    expect(isGovernedSourcePath("src/schema.generated.ts")).toBe(false);
  });

  it("reports new suppressions, stale debt, and baseline growth", () => {
    const baseline = parseBaseline("# debt\nsrc/a.ts\nsrc/b.ts\n");
    expect(diffBaseline(["src/b.ts", "src/c.ts"], baseline)).toEqual({
      added: ["src/c.ts"],
      stale: ["src/a.ts"],
    });
    expect(findBaselineExpansion(baseline, new Set(["src/a.ts"]))).toEqual(["src/b.ts"]);
  });

  it("rejects baseline growth even when the new suppression is listed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(
      path.join(root, "src/a.ts"),
      "/* oxlint-disable max-lines -- TODO: split. */\n",
    );
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    }

    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\nsrc/b.ts\n");
    fs.writeFileSync(
      path.join(root, "src/b.ts"),
      "/* oxlint-disable max-lines -- TODO: split. */\n",
    );
    execFileSync("git", ["add", "."], { cwd: root });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(1);
  });

  it("defaults worktree comparisons to origin/main", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-default-base-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable max-lines */\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    }
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });

    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\nsrc/b.ts\n");
    fs.writeFileSync(path.join(root, "src/b.ts"), "/* oxlint-disable max-lines */\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "grow baseline"], { cwd: root, stdio: "ignore" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root)).toBe(1);
  });

  it("checks staged content instead of unstaged worktree edits", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-staged-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    }

    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable */\n");
    execFileSync("git", ["add", "."], { cwd: root });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root, ["--staged", "--base", "HEAD"])).toBe(1);
  });

  it("keeps staged filenames NUL-framed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-nul-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const filePath = "src/newline\nname.ts";
    fs.writeFileSync(path.join(root, filePath), "/* oxlint-disable max-lines */\n");
    execFileSync("git", ["add", "."], { cwd: root });

    expect(collectCurrentSuppressions(root, { staged: true })).toEqual([filePath]);
  });

  it("checks untracked sources and tolerates unstaged deletions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-worktree-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/deleted.ts"), "export const deleted = true;\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    }
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
    fs.rmSync(path.join(root, "src/deleted.ts"));
    expect(main(root)).toBe(0);

    fs.writeFileSync(path.join(root, "src/untracked.ts"), "/* oxlint-disable */\n");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root)).toBe(1);
  });
});
