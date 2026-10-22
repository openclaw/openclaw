import { spawnSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveDevTool } from "../../scripts/lib/dev-tool.mts";
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
  ["lint", {}, false],
  ["lint", { CI: "true" }, false],
  ["lint", { OPENCLAW_LINT_TOOL: "bun", PATH: "/usr/bin" }, true],
  ["format", { OPENCLAW_FORMAT_TOOL: "bun" }, "error", false],
  ["format", {}, false, false],
] as const)("selects %s for %j", (kind, env, bun, availability?: boolean) => {
  const available = availability ?? true;
  const resolvePinnedBun = vi.fn(() => (available ? pinnedBun : unavailable));
  const notice = vi.fn();
  const run = () => resolveDevTool(kind, env, { resolvePinnedBun, notice });
  if (bun === "error") {
    expect(run).toThrow("OPENCLAW_FORMAT_TOOL=bun: unavailable");
    expect(notice).not.toHaveBeenCalled();
    return;
  }
  const tool = run();
  expect(tool.command === "/pinned/bin/bun").toBe(bun);
  expect(resolvePinnedBun).toHaveBeenCalledTimes(bun || !available ? 1 : 0);
  if (available) {
    expect(notice).not.toHaveBeenCalled();
  } else {
    const args = [path.resolve("node_modules/oxfmt/bin/oxfmt")];
    expect(tool).toMatchObject({ command: process.execPath, args });
    expect(notice).toHaveBeenCalledExactlyOnceWith("[openclaw] unavailable; using oxfmt.");
  }
  if (kind === "lint" && bun) {
    expect(tool.args).toEqual(["lint"]);
    expect(tool.env.PATH?.split(/[:;]/u)[0]).toBe("/pinned/bin");
    expect(tool.env.npm_lifecycle_event).toBe("lint");
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
