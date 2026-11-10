import { spawnSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveDevTool } from "../../scripts/lib/dev-tool.mts";
import { compareLintResults } from "../../scripts/lib/lint-parity.mts";
import { compareFormatResults } from "../../scripts/run-format.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const pinnedBun = { command: "/pinned/bin/bun" };
const unavailable = { reason: "unavailable" };
it.each([
  ["format", {}, true],
  ["format", { CI: "true" }, false],
  ["format", { CI: "false" }, true],
  ["format", { OPENCLAW_FORMAT_TOOL: "oxfmt" }, false],
  ["format", { OPENCLAW_FORMAT_TOOL: "bun" }, true],
  ["format", { CI: "true", OPENCLAW_FORMAT_TOOL: "bun" }, true],
  ["lint", {}, true],
  ["lint", { CI: "false" }, true],
  ["lint", { OPENCLAW_LINT_TOOL: "oxlint" }, false],
  ["lint", { CI: "true" }, false],
  ["lint", { OPENCLAW_LINT_TOOL: "bun", PATH: "/usr/bin" }, true],
  ["format", { OPENCLAW_FORMAT_TOOL: "bun" }, "error", false],
  ["format", {}, false, false],
  ["lint", {}, false, false],
  ["lint", { OPENCLAW_LINT_TOOL: "bun" }, "error", false],
] as const)("selects %s for %j", (kind, env, bun, availability?: boolean) => {
  const available = availability ?? true;
  const resolvePinnedBun = vi.fn(() => (available ? pinnedBun : unavailable));
  const notice = vi.fn();
  const run = () => resolveDevTool(kind, env, { resolvePinnedBun, notice });
  if (bun === "error") {
    expect(run).toThrow(`OPENCLAW_${kind.toUpperCase()}_TOOL=bun: unavailable`);
    expect(notice).not.toHaveBeenCalled();
    return;
  }
  const tool = run();
  expect(tool.command === "/pinned/bin/bun").toBe(bun);
  expect(resolvePinnedBun).toHaveBeenCalledTimes(bun || !available ? 1 : 0);
  if (available) {
    expect(notice).not.toHaveBeenCalled();
  } else {
    const fallback = kind === "format" ? "oxfmt" : "oxlint";
    expect(tool).toMatchObject(
      kind === "format"
        ? { command: process.execPath, args: [path.resolve("node_modules/oxfmt/bin/oxfmt")] }
        : { command: path.resolve("node_modules/.bin/oxlint"), args: [] },
    );
    expect(notice).toHaveBeenCalledExactlyOnceWith(`[openclaw] unavailable; using ${fallback}.`);
  }
  if (kind === "lint" && bun) {
    expect(tool.args).toEqual(["lint", "--no-script"]);
    expect(tool.env.PATH?.split(/[:;]/u)[0]).toBe("/pinned/bin");
  }
});

it("rejects an invalid override", () => {
  const invalid = () => resolveDevTool("format", { OPENCLAW_FORMAT_TOOL: "typo" });
  expect(invalid).toThrow("OPENCLAW_FORMAT_TOOL must be bun or oxfmt");
});
it.each([
  ["bun", "export const value=1;", "process.exit(0);"],
  ["oxfmt", "export const value = 1;\n", 'console.log("file.ts"); process.exit(1);'],
])("CI enforces both tools despite the %s override", (override, source, bunOutput) => {
  const root = createTempDir("format-parity-");
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  writeFileSync(path.join(root, ".oxfmtrc.jsonc"), "{}");
  writeFileSync(path.join(root, "file.ts"), source);
  // Node stands in for Bun and executes this fixed report as its `fmt` command.
  writeFileSync(path.join(root, "fmt"), bunOutput);
  const node = resolveTestNodeExecPath();
  const result = spawnSync(node, [path.resolve("scripts/run-format.mts"), "--check", "file.ts"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "true",
      OPENCLAW_FORMAT_TOOL: override,
      OPENCLAW_BUN_PATH: node,
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("[format] parity failed");
});

describe("lint parity", () => {
  it.each([
    ["bun", "const unused = 1;", false],
    ["oxlint", "const unused = 1;", false],
    ["bun", "export const used = 1;", true],
  ] as const)(
    "CI compares diagnostics with override %s and source %s",
    (override, source, matches) => {
      const root = createTempDir("lint-parity-");
      symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
      writeFileSync(
        path.join(root, ".oxlintrc.json"),
        JSON.stringify({
          categories: { correctness: "off" },
          rules: { "no-unused-vars": "error" },
        }),
      );
      writeFileSync(path.join(root, "file.ts"), source);
      // Node executes this fixed empty report as Bun's native `lint` command.
      writeFileSync(path.join(root, "lint"), "console.log('{\"diagnostics\":[]}');");
      const result = spawnSync(
        resolveTestNodeExecPath(),
        [path.resolve("scripts/run-oxlint.mjs"), "--openclaw-focused-config", "file.ts"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CI: "true",
            OPENCLAW_LINT_TOOL: override,
            OPENCLAW_BUN_PATH: resolveTestNodeExecPath(),
          },
        },
      );
      expect(result.status).toBe(matches ? 0 : 1);
      if (matches) {
        expect(result.stderr).not.toContain("[lint] parity failed");
      } else {
        expect(result.stderr).toContain("[lint] parity failed");
      }
    },
  );

  const diagnostic = {
    filename: "file.ts",
    code: "eslint(no-unused-vars)",
    message: "Unused variable.",
    severity: "error",
    help: "Remove it.",
    labels: [{ span: { offset: 6, length: 6, line: 1, column: 7 } }],
  };
  const result = (diagnostics: object[], status = 1) => ({
    status,
    stdout: JSON.stringify({ diagnostics }),
  });

  it("normalizes rule spelling and URLs without comparing timing or report order", () => {
    expect(
      compareLintResults(
        result([diagnostic, { ...diagnostic, filename: "other.ts" }]),
        result([
          {
            ...diagnostic,
            filename: "other.ts",
            code: "no-unused-vars",
            url: "https://example.test/rule",
          },
          { ...diagnostic, code: "no-unused-vars" },
        ]),
      ),
    ).toBe(true);
  });

  it.each([
    { message: "Different message." },
    { severity: "warning" },
    { help: "Different help." },
    { labels: [{ span: { offset: 7, length: 6, line: 1, column: 8 } }] },
    { code: "eslint(no-undef)" },
    { filename: "other.ts" },
  ])("rejects changed diagnostic payloads: %j", (change) => {
    expect(compareLintResults(result([diagnostic]), result([{ ...diagnostic, ...change }]))).toBe(
      false,
    );
  });

  it("preserves diagnostic multiplicity and exit status", () => {
    expect(compareLintResults(result([diagnostic]), result([diagnostic, diagnostic]))).toBe(false);
    expect(compareLintResults(result([], 0), result([], 1))).toBe(false);
  });
});

const output = (status: number, stdout = "") => ({ status, stdout });
const timing = (ms: number) => `Finished in ${ms}ms on 0 files using 4 threads.\n`;
it.each([
  [output(0, timing(1)), output(0, timing(0)), true],
  [output(0), output(0), true],
  [output(0), output(1, "a.ts\n"), false],
  [output(1, "a.ts"), output(0), false],
  [output(1, "a.ts"), output(1, "b.ts\n"), false],
  [output(1, "b.ts\na.ts"), output(1, "a.ts\nb.ts\n"), true],
])("compares each tool's changed-file set", (oxfmt, bun, matches) => {
  expect(compareFormatResults(oxfmt, bun)).toBe(matches);
});
