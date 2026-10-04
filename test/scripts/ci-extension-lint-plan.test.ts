import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCiExtensionLintSelection } from "../../scripts/lib/ci-extension-lint-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function workspace() {
  const cwd = tempDirs.make("extension-lint-selection-");
  const git = (args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    );
  const write = (file: string, content: string) => {
    const target = path.join(cwd, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    if (existsSync(path.join(cwd, ".git"))) {
      git(["add", "--", file]);
    }
  };
  write("package.json", '{"type":"module"}');
  write("pnpm-workspace.yaml", "packages:\n  - extensions/*\n");
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        paths: { "openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"] },
      },
    }),
  );
  for (const id of ["alpha", "beta", "unrelated", "telegram", "codex", "slack"]) {
    write(`extensions/${id}/package.json`, '{"private":true}');
    write(`extensions/${id}/index.ts`, "export {};\n");
  }
  write("scripts/lib/plugin-sdk-entrypoints.json", '["api", "public"]');
  write("scripts/lib/plugin-sdk-private-local-only-subpaths.json", "[]");
  write("src/plugin-sdk/api.ts", "export type Result = Promise<void>;\n");
  write("src/plugin-sdk/public.ts", 'export type { Result } from "./api.js";\n');
  write(
    "extensions/alpha/index.ts",
    'import type { Result } from "openclaw/plugin-sdk/public"; export type Response = Result;\n',
  );
  write(
    "extensions/beta/index.ts",
    'import type { Response } from "../alpha/index.js"; export type Reply = Response;\n',
  );
  write("src/leaf.ts", "export const value = 1;\n");
  git(["init", "--quiet"]);
  const commitBase = () => {
    git(["add", "."]);
    git(["commit", "--quiet", "--allow-empty", "-m", "fixture base"]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  const baseRef = commitBase();
  return { cwd, write, baseRef };
}

const smokeRoots = ["extensions/codex", "extensions/slack", "extensions/telegram"];
type SelectionCase = {
  files: string[];
  roots: string[];
  pinned?: boolean;
  testImport?: boolean;
  reasons?: Record<string, string[]>;
};
const selectedCases: SelectionCase[] = [
  {
    files: ["src/plugin-sdk/public.ts", "extensions/unrelated/openclaw.plugin.json"],
    roots: ["extensions/alpha", ...smokeRoots, "extensions/unrelated"],
    pinned: true,
    reasons: {
      "extensions/alpha": [
        "direct import of changed public entry openclaw/plugin-sdk/public: extensions/alpha/index.ts",
      ],
      "extensions/unrelated": ["PR changes extensions/unrelated/openclaw.plugin.json"],
    },
  },
  { files: ["ui/src/leaf.ts", "docs/example.md"], roots: [], reasons: {} },
  { files: ["src/leaf.ts"], roots: smokeRoots },
  { files: ["scripts/lib/settings.mts"], roots: smokeRoots },
  { files: ["extensions/alpha/package.json"], roots: ["extensions/alpha"] },
  {
    files: ["src/plugin-sdk/api.ts"],
    roots: [...smokeRoots, "extensions/unrelated"],
    pinned: true,
    testImport: true,
    reasons: {
      "extensions/unrelated": [
        "direct import of changed public entry openclaw/plugin-sdk/api: extensions/unrelated/api.test.ts",
      ],
    },
  },
];
type FullCase = {
  file: string;
  options?: { forceFull?: boolean; baseRef?: string };
  reason?: string;
};
const fullCases: FullCase[] = [
  ...[
    "pnpm-lock.yaml",
    "extensions/tsconfig.json",
    "config/oxlint/boundary-guards.json",
    "config/tsconfig/oxlint.json",
    "patches/example.patch",
    "src/state/openclaw-state-schema.sql",
  ].map((file) => ({ file })),
  { file: "extensions/shared.ts", reason: "direct shared extension source: extensions/shared.ts" },
  {
    file: "docs/example.md",
    options: { forceFull: true },
    reason: "OPENCLAW_CI_EXTENSION_LINT_FULL",
  },
  {
    file: "src/plugin-sdk/public.ts",
    options: { baseRef: "a".repeat(40) },
    reason: "direct public-entry inventory unavailable",
  },
];

describe("extension lint package selection", () => {
  it.each(selectedCases)(
    "selects direct owners and smoke consumers of $files",
    async (testCase) => {
      const { cwd, write, baseRef } = workspace();
      if (testCase.testImport) {
        write(
          "extensions/unrelated/api.test.ts",
          'import type { Result } from "openclaw/plugin-sdk/api"; export type TestResult = Result;\n',
        );
      }
      const selection = await resolveCiExtensionLintSelection(
        testCase.files,
        cwd,
        testCase.pinned ? { baseRef } : {},
      );
      expect(selection.mode).toBe("selected");
      expect(selection.extensionRoots).toEqual(testCase.roots);
      expect(selection.fullReasons).toEqual([]);
      if (testCase.reasons) {
        if (testCase.roots.length === 0) {
          expect(selection).toEqual({
            mode: "selected",
            extensionRoots: [],
            reasons: {},
            fullReasons: [],
          });
        } else {
          for (const [root, reasons] of Object.entries(testCase.reasons)) {
            expect(selection.reasons[root]).toEqual(reasons);
          }
        }
      }
    },
  );

  it.each(fullCases)("retains full lint for $file", async ({ file, options, reason }) => {
    const { cwd } = workspace();
    const selection = await resolveCiExtensionLintSelection([file], cwd, options);
    expect(selection.mode).toBe("full");
    expect(selection.fullReasons).toHaveLength(1);
    if (reason) {
      expect(selection.fullReasons).toEqual([reason]);
    }
    if (file === "extensions/shared.ts") {
      expect(selection.extensionRoots).toEqual([]);
    }
  });
});
