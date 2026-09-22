import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectCurrentSuppressionState,
  collectLintDisableDirectives,
  isGovernedSourcePath,
  main,
} from "../../scripts/check-max-lines-ratchet.mts";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = createTempDirTracker();
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
  tempDirs.cleanup();
});

describe("check-max-lines-ratchet", () => {
  it.each([
    { mode: "worktree", status: 0, stderr: "" },
    { mode: "staged", status: 0, stderr: "" },
    {
      mode: "count growth",
      status: 1,
      stderr: "OPENCLAW_* count 4 exceeds budget 3; update config/env-var-count-budget.txt\n",
    },
    {
      mode: "max-lines failure first",
      status: 1,
      stderr:
        "All-rule lint disables are forbidden; name only the required rules:\n  src/suppressed.ts\n",
    },
    {
      mode: "budget growth before env-only reads",
      status: 1,
      stderr: "OPENCLAW_* budget grew from 3 to 4\n",
    },
  ])("runs both ratchets through the CLI: $mode", ({ mode, status, stderr }) => {
    const root = tempDirs.make("openclaw-combined-ratchets-", os.tmpdir());
    const files = {
      "config/max-lines-baseline.txt": "src/suppressed.ts\n",
      "config/env-var-count-budget.txt": "3\n",
      "src/suppressed.ts": "/* oxlint-disable max-lines */\nprocess.env.OPENCLAW_ONE;\n",
      "src/runtime.ts": 'const value = "é 🦞 OPENCLAW_SHARED OPENCLAW_SHARED";\n',
      "src/empty.ts": "export const value = 1;\n",
      "src/runtime.test.ts": "process.env.OPENCLAW_TEST_ONLY;\n",
      "ui/src/runtime.ts": "process.env.OPENCLAW_UI_ONLY;\n",
      "packages/api/schema.generated.ts": "process.env.OPENCLAW_GENERATED;\n",
    };
    for (const [file, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source);
    }
    commitFixture(root);
    if (mode === "staged") {
      fs.writeFileSync(path.join(root, "config/env-var-count-budget.txt"), "0\n");
      fs.writeFileSync(path.join(root, "src/suppressed.ts"), "/* oxlint-disable */\n");
      fs.writeFileSync(path.join(root, "src/runtime.ts"), "process.env.OPENCLAW_WORKTREE;\n");
    } else if (mode === "count growth") {
      fs.writeFileSync(path.join(root, "src/untracked.ts"), "process.env.OPENCLAW_NEW;\n");
    } else if (mode === "max-lines failure first") {
      fs.writeFileSync(path.join(root, "src/suppressed.ts"), "/* oxlint-disable */\n");
      fs.writeFileSync(path.join(root, "config/env-var-count-budget.txt"), "invalid\n");
    } else if (mode === "budget growth before env-only reads") {
      fs.writeFileSync(path.join(root, "config/env-var-count-budget.txt"), "4\n");
      const generatedPath = path.join(root, "packages/api/schema.generated.ts");
      fs.rmSync(generatedPath);
      fs.mkdirSync(generatedPath);
    }
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/tsx.mjs")).href,
        path.resolve(import.meta.dirname, "../../scripts/check-max-lines-ratchet.mts"),
        ...(mode === "staged" ? ["--staged"] : []),
        "--base",
        "HEAD",
      ],
      {
        cwd: root,
        env: {
          ...fixtureEnv(),
          TSX_TSCONFIG_PATH: path.resolve(import.meta.dirname, "../../tsconfig.json"),
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(status);
    expect(result.stderr).toBe(stderr);
    expect(result.stdout).toBe(
      mode === "max-lines failure first"
        ? ""
        : "max-lines ratchet OK: 1 grandfathered suppressions.\n" +
            (status === 0 ? "OPENCLAW_* count 3/3\n" : ""),
    );
  });

  it.each(["\n", "\r\n"])("preserves directive discovery with %j line endings", (newline) => {
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

    expect(collectLintDisableDirectives(source)).toEqual([
      ["no-debugger"],
      ["no-console"],
      ["no-console"],
      ["max-lines", "eqeqeq"],
    ]);
  });

  it.each<[string, string[][]]>([
    ["/* oxlint-disable max-lines -- TODO: split. */\n", [["max-lines"]]],
    ["// eslint-disable-next-line no-console, max-lines\n", [["no-console", "max-lines"]]],
    ["/* oxlint-disable */\n", [[]]],
    ["// oxlint-disable-line -- all rules\n", [[]]],
    ["/* oxlint-disable max-lines - TODO: split. */\n", [["max-lines"]]],
    ["/* oxlint-disable max-lines--temporary */\n", [["max-lines"]]],
    ["/* oxlint-disable - all rules */\n", [[]]],
    ["/* oxlint-disable eslint/max-lines */\n", [["eslint/max-lines"]]],
    ["/* oxlint-disable\nmax-lines\n-- TODO: split. */\n", [["max-lines"]]],
    ["export const value = 1;\n/* oxlint-disable max-lines -- TODO: split. */\n", [["max-lines"]]],
    ["if (true) {\n  const value = 1;\n  /* oxlint-disable max-lines */\n}\n", [["max-lines"]]],
    ["/* oxlint-disable no-console -- mentions max-lines */\n", [["no-console"]]],
    ["// Example: oxlint-disable max-lines\n", []],
    ['const example = "/* oxlint-disable max-lines */";\n', []],
  ])("parses directive rules without matching reason prose: %j", (source, directives) => {
    expect(collectLintDisableDirectives(source)).toEqual(directives);
  });

  it("limits source roots and excludes generated output", () => {
    expect(isGovernedSourcePath("src/runtime.ts")).toBe(true);
    expect(isGovernedSourcePath("extensions/demo/index.mjs")).toBe(true);
    expect(isGovernedSourcePath("scripts/tool.mjs")).toBe(false);
    expect(isGovernedSourcePath("packages/api/protocol-gen/types.ts")).toBe(false);
    expect(isGovernedSourcePath("ui/src/i18n/locales/en.ts")).toBe(false);
    expect(isGovernedSourcePath("src/wizard/i18n/locales/en.ts")).toBe(false);
    expect(isGovernedSourcePath("src/schema.generated.ts")).toBe(false);
  });

  it("rejects baseline growth even when the new suppression is listed", () => {
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
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(1);
  });

  it("rejects replacing an explicit max-lines suppression with an all-rule disable", () => {
    const root = tempDirs.make("openclaw-max-lines-all-rule-", os.tmpdir());
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable max-lines */\n");
    commitFixture(root);

    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable */\n");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(1);
  });

  it("rejects a new all-rule disable without baseline growth", () => {
    const root = tempDirs.make("openclaw-max-lines-all-rule-new-", os.tmpdir());
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    commitFixture(root);

    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable */\n");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(1);
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

  it("defaults worktree comparisons to origin/main", () => {
    const root = tempDirs.make("openclaw-max-lines-default-base-", os.tmpdir());
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable max-lines */\n");
    commitFixture(root);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\nsrc/b.ts\n");
    fs.writeFileSync(path.join(root, "src/b.ts"), "/* oxlint-disable max-lines */\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "grow baseline"]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root)).toBe(1);
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
