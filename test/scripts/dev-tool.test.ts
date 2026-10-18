import { spawnSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveDevTool } from "../../scripts/lib/dev-tool.mts";
import { compareFormatResults } from "../../scripts/run-format.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("development tool selection", () => {
  it.each([
    ["format", {}, false],
    ["format", { CI: "true" }, false],
    ["format", { CI: "false" }, false],
    ["format", { OPENCLAW_FORMAT_TOOL: "oxfmt" }, false],
    ["format", { OPENCLAW_FORMAT_TOOL: "bun" }, true],
    ["format", { CI: "true", OPENCLAW_FORMAT_TOOL: "bun" }, true],
    ["lint", {}, false],
    ["lint", { CI: "true" }, false],
    ["lint", { OPENCLAW_LINT_TOOL: "bun" }, true],
  ] as const)("selects %s for %j", (kind, env, bun) => {
    const resolvePinnedBun = vi.fn(() => ({ command: "/pinned/bin/bun" }));
    const notice = vi.fn();
    const tool = resolveDevTool(kind, env, { resolvePinnedBun, notice });
    expect(tool.command === "/pinned/bin/bun").toBe(bun);
    expect(resolvePinnedBun).toHaveBeenCalledTimes(bun ? 1 : 0);
    expect(notice).not.toHaveBeenCalled();
  });

  it("runs the built-in lint command with the pinned runtime on PATH", () => {
    const tool = resolveDevTool(
      "lint",
      { OPENCLAW_LINT_TOOL: "bun", PATH: "/usr/bin" },
      {
        resolvePinnedBun: () => ({ command: "/pinned/bin/bun" }),
        notice: vi.fn(),
      },
    );
    expect(tool.args).toEqual(["lint"]);
    expect(tool.env.PATH?.split(/[:;]/u)[0]).toBe("/pinned/bin");
    expect(tool.env.npm_lifecycle_event).toBe("lint");
  });

  it("fails an unavailable explicit Bun request instead of silently changing tools", () => {
    const notice = vi.fn();
    expect(() =>
      resolveDevTool(
        "format",
        { OPENCLAW_FORMAT_TOOL: "bun" },
        {
          resolvePinnedBun: () => ({ reason: "unavailable" }),
          notice,
        },
      ),
    ).toThrow("OPENCLAW_FORMAT_TOOL=bun: unavailable");
    expect(notice).not.toHaveBeenCalled();
  });

  it("rejects an invalid override", () => {
    expect(() => resolveDevTool("format", { OPENCLAW_FORMAT_TOOL: "typo" })).toThrow(
      "OPENCLAW_FORMAT_TOOL must be bun or oxfmt",
    );
  });
});

describe("format parity", () => {
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

  it.each([
    [{ status: 0, stdout: "" }, { status: 0, stdout: "" }, true],
    [{ status: 0, stdout: "" }, { status: 1, stdout: "a.ts\n" }, false],
    [{ status: 1, stdout: "a.ts" }, { status: 0, stdout: "" }, false],
    [{ status: 1, stdout: "a.ts" }, { status: 1, stdout: "b.ts\n" }, false],
    [{ status: 1, stdout: "b.ts\na.ts" }, { status: 1, stdout: "a.ts\nb.ts\n" }, true],
  ])("compares each tool's changed-file set", (oxfmt, bun, matches) => {
    expect(compareFormatResults(oxfmt, bun)).toBe(matches);
  });
});
