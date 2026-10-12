import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectCurrentSuppressionState,
  collectLintDisableDirectives,
  isGovernedSourcePath,
  main,
} from "../../scripts/check-max-lines-ratchet.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

const tempDirs = createTempDirTracker();
beforeEach(() => vi.stubEnv("GITHUB_ACTIONS", ""));
const nestedGitEnvKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of nestedGitEnvKeys) {
    delete env[key];
  }
  return env;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
    cwd,
    env: fixtureEnv(),
    stdio: "ignore",
  });
}

function commitFixture(root: string, message = "base"): void {
  for (const args of [["init"], ["add", "."], ["commit", "-m", message]]) {
    git(root, args);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

describe("check-max-lines-ratchet", () => {
  it.each(["\r\n"])("preserves directive discovery with %j line endings", (newline) => {
    const source = [
      'const text = "\u{1f680} /* oxlint-disable max-lines */";',
      "const template = `// eslint-disable max-lines`;",
      "function example() {",
      "  /* oxlint-disable no-console */",
      "} // eslint-disable no-debugger",
      "consume(",
      "  1",
      "  // oxlint-disable no-console",
      ");",
      "// eslint-disable max-lines, eqeqeq",
    ].join(newline);

    expect(
      collectLintDisableDirectives(source, "file.ts", parser.parseSourceFile("file.ts", source)),
    ).toEqual([["no-console"], ["no-debugger"], ["no-console"], ["max-lines", "eqeqeq"]]);
  });

  it.each<[string, string[][]]>([["// Example: oxlint-disable max-lines\n", []]])(
    "parses directive rules without matching reason prose: %j",
    (source, directives) => {
      expect(
        collectLintDisableDirectives(source, "file.ts", parser.parseSourceFile("file.ts", source)),
      ).toEqual(directives);
    },
  );

  it("limits source roots and excludes generated output", () => {
    expect(isGovernedSourcePath("src/runtime.ts")).toBe(true);
    expect(isGovernedSourcePath("extensions/demo/index.mjs")).toBe(true);
    expect(isGovernedSourcePath("scripts/tool.mjs")).toBe(false);
    expect(isGovernedSourcePath("packages/api/protocol-gen/types.ts")).toBe(false);
    expect(isGovernedSourcePath("ui/src/i18n/locales/en.ts")).toBe(false);
    expect(isGovernedSourcePath("src/wizard/i18n/locales/en.ts")).toBe(false);
    expect(isGovernedSourcePath("src/schema.generated.ts")).toBe(false);
  });

  it.each([true])("reports baseline growth even when listed (CI=%s)", (advisory) => {
    const root = tempDirs.make("openclaw-max-lines-", os.tmpdir());
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(
      path.join(root, "src/a.ts"),
      "/* oxlint-disable max-lines -- TODO: split. */\n",
    );
    commitFixture(root);

    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\nsrc/b.ts\n");
    fs.writeFileSync(
      path.join(root, "src/b.ts"),
      "/* oxlint-disable max-lines -- TODO: split. */\n",
    );
    git(root, ["add", "."]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GITHUB_ACTIONS", advisory ? "true" : "");
    vi.stubEnv("GITHUB_STEP_SUMMARY", path.join(root, "summary.md"));
    expect(main(root, ["--base", "HEAD"])).toBe(advisory ? 0 : 1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("The max-lines baseline may only shrink"),
    );
    if (advisory) {
      expect(fs.readFileSync(path.join(root, "summary.md"), "utf8")).toContain("src/b.ts");
    }
  });

  it("transfers grandfathered debt across a verified rename", () => {
    const root = tempDirs.make("openclaw-max-lines-rename-", os.tmpdir());
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(
      path.join(root, "src/a.ts"),
      "export const a = 1;\n/* oxlint-disable max-lines -- TODO: split. */\n",
    );
    commitFixture(root);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    git(root, ["mv", "src/a.ts", "src/b.ts"]);
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/b.ts\n");

    expect(main(root)).toBe(0);
  });

  it("compares an explicit moving base at the branch fork", () => {
    const root = tempDirs.make("openclaw-max-lines-diverged-", os.tmpdir());
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\nsrc/b.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable max-lines */\n");
    fs.writeFileSync(path.join(root, "src/b.ts"), "/* oxlint-disable max-lines */\n");
    commitFixture(root);
    git(root, ["branch", "release"]);

    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/b.ts"), "export const b = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "shrink main debt"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, ["checkout", "release"]);

    expect(main(root, ["--base", "origin/main"])).toBe(0);
  });

  it("falls back to main when no merge base is available", () => {
    const root = tempDirs.make("openclaw-max-lines-disconnected-", os.tmpdir());
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable max-lines */\n");
    commitFixture(root, "release");
    git(root, ["branch", "-m", "release"]);
    git(root, ["checkout", "--orphan", "main"]);
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "disconnected main"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, ["checkout", "release"]);

    expect(main(root)).toBe(1);
  });

  it("checks staged content instead of unstaged worktree edits", () => {
    const root = tempDirs.make("openclaw-max-lines-staged-", os.tmpdir());
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    commitFixture(root);

    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable */\n");
    git(root, ["add", "."]);
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root, ["--staged", "--base", "HEAD"])).toBe(1);
  });

  it.skipIf(process.platform === "win32")("keeps staged filenames NUL-framed", () => {
    const root = tempDirs.make("openclaw-max-lines-nul-", os.tmpdir());
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    git(root, ["init"]);
    const filePath = "src/newline\nname.ts";
    fs.writeFileSync(path.join(root, filePath), "/* oxlint-disable max-lines */\n");
    git(root, ["add", "."]);

    expect(collectCurrentSuppressionState(root, { staged: true }).explicit).toEqual([filePath]);
  });

  it("checks untracked sources and tolerates unstaged deletions", () => {
    const root = tempDirs.make("openclaw-max-lines-worktree-", os.tmpdir());
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/deleted.ts"), "export const deleted = true;\n");
    commitFixture(root);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fs.rmSync(path.join(root, "src/deleted.ts"));
    expect(main(root)).toBe(0);

    fs.writeFileSync(
      path.join(root, "src/untracked.ts"),
      "// eslint-disable-next-line eslint/max-lines\n",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root)).toBe(1);
  });
});
