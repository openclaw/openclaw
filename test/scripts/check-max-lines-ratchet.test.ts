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

const baselinePath = "config/max-lines-baseline.txt";
const suppression = "/* oxlint-disable max-lines */\n";
function write(root: string, file: string, source: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function makeRepo(files: Record<string, string>, message = "base") {
  const root = tempDirs.make("openclaw-max-lines-", os.tmpdir());
  for (const [file, source] of Object.entries(files)) {
    write(root, file, source);
  }
  commitFixture(root, message);
  return root;
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

  it("reports baseline growth as an advisory in GitHub Actions even when listed", () => {
    const source = "/* oxlint-disable max-lines -- TODO: split. */\n";
    const root = makeRepo({ [baselinePath]: "src/a.ts\n", "src/a.ts": source });
    write(root, baselinePath, "src/a.ts\nsrc/b.ts\n");
    write(root, "src/b.ts", source);
    git(root, ["add", "."]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_STEP_SUMMARY", path.join(root, "summary.md"));
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("The max-lines baseline may only shrink"),
    );
    expect(fs.readFileSync(path.join(root, "summary.md"), "utf8")).toContain("src/b.ts");
  });

  it("transfers grandfathered debt across a verified rename", () => {
    const root = makeRepo({
      [baselinePath]: "src/a.ts\n",
      "src/a.ts": "export const a = 1;\n/* oxlint-disable max-lines -- TODO: split. */\n",
    });
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    git(root, ["mv", "src/a.ts", "src/b.ts"]);
    write(root, baselinePath, "src/b.ts\n");

    expect(main(root)).toBe(0);
  });

  it("compares an explicit moving base at the branch fork", () => {
    const root = makeRepo({
      [baselinePath]: "src/a.ts\nsrc/b.ts\n",
      "src/a.ts": suppression,
      "src/b.ts": suppression,
    });
    git(root, ["branch", "release"]);

    write(root, baselinePath, "src/a.ts\n");
    write(root, "src/b.ts", "export const b = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "shrink main debt"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, ["checkout", "release"]);

    expect(main(root, ["--base", "origin/main"])).toBe(0);
  });

  it("rejects unavailable ancestry with an explicit prepared-base recovery", () => {
    const root = makeRepo({ [baselinePath]: "src/a.ts\n", "src/a.ts": suppression }, "release");
    git(root, ["branch", "-m", "release"]);
    git(root, ["checkout", "--orphan", "main"]);
    write(root, baselinePath, "");
    write(root, "src/a.ts", "export const a = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "disconnected main"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, ["checkout", "release"]);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(root)).toBe(1);
    expect(errors).toHaveBeenCalledWith(
      "Could not resolve ratchet merge base for origin/main; provide reachable history or --base <prepared-ref> --no-merge-base.",
    );
  });

  it("checks staged content instead of unstaged worktree edits", () => {
    const root = makeRepo({ [baselinePath]: "", "src/a.ts": "export const a = 1;\n" });
    write(root, baselinePath, "src/a.ts\n");
    write(root, "src/a.ts", "/* oxlint-disable */\n");
    git(root, ["add", "."]);
    write(root, baselinePath, "");
    write(root, "src/a.ts", "export const a = 1;\n");
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
    const root = makeRepo({
      [baselinePath]: "",
      "src/deleted.ts": "export const deleted = true;\n",
    });
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fs.rmSync(path.join(root, "src/deleted.ts"));
    expect(main(root)).toBe(0);

    write(root, "src/untracked.ts", "// eslint-disable-next-line eslint/max-lines\n");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root)).toBe(1);
  });
});
