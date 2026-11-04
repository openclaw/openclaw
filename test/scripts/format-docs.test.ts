import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDocs } from "../../scripts/format-docs.mts";
import { createScriptTestHarness } from "./test-helpers.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const { createTempDir } = createScriptTestHarness();
let root: string;
beforeEach(() => {
  root = createTempDir("openclaw-format-docs-");
});

afterEach(() => {
  vi.mocked(spawnSync).mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function commandResult(stdout = "", stderr = "", status = 0): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null };
}

function mockFormatter(files = ["README.md", "docs/guide.mdx"], run = () => commandResult()) {
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "# Guide\n", "utf8");
  }
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    if (command === "git") {
      return args?.[0] === "ls-files" ? commandResult(files.join("\n")) : commandResult("", "", 1);
    }
    calls.push({ command, args: args ?? [], options });
    return run();
  });
  return calls;
}

describe("format-docs", () => {
  it("wraps the Windows oxfmt.cmd shim through cmd.exe", () => {
    const shim = path.join(root, "node_modules", ".bin", "oxfmt.cmd");
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, "@echo off\n");
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const calls = mockFormatter();

    formatDocs({ root });

    expect(calls).toEqual([
      {
        command: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", expect.stringMatching(/oxfmt\.cmd.*--write.*docs\/guide\.mdx/u)],
        options: expect.objectContaining({ shell: false, windowsVerbatimArguments: true }),
      },
    ]);
  });

  it("batches oxfmt invocations without losing docs that exceed the command line budget", () => {
    const files = Array.from({ length: 150 }, (_, index) => `docs/${index}-${"a".repeat(180)}.md`);
    const calls = mockFormatter(files);

    formatDocs({ root });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.command === process.execPath)).toBe(true);
    expect(calls.flatMap((call) => call.args.slice(5))).toEqual(files);
  });

  it("keeps Windows batches inside the cmd.exe command-line limit", () => {
    // cmd.exe refuses a command line longer than this, well below the CreateProcess limit.
    const CMD_EXE_MAX_COMMAND_LINE = 8191;
    const root = createTempDir("openclaw-format-docs-windows-batch-");
    const files = Array.from({ length: 150 }, (_, index) => `docs/${index}-${"a".repeat(180)}.md`);
    writeDocsFixture(root, files);
    const shim = path.join(root, "node_modules", ".bin", "oxfmt.cmd");
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, "@echo off\n");
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const calls = mockFormatter(files);

    formatDocs({ root });

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.command).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(String(call.args[3]).length).toBeLessThanOrEqual(CMD_EXE_MAX_COMMAND_LINE);
    }
    for (const file of files) {
      expect(calls.some((call) => String(call.args[3]).includes(file))).toBe(true);
    }
  });

  it("reports git and oxfmt spawn diagnostics", () => {
    vi.mocked(spawnSync).mockReturnValue(commandResult("", "fatal: not a git repository", 128));
    expect(() => formatDocs({ root })).toThrow(
      /git ls-files failed:[\s\S]*exit status: 128[\s\S]*fatal: not a git repository/u,
    );

    mockFormatter(["README.md"], () =>
      commandResult("formatter stdout", `你好${"x".repeat(16_380)}`, 1),
    );
    expect(() => formatDocs({ root })).toThrow(
      /oxfmt failed:[\s\S]*command:[\s\S]*exit status: 1[\s\S]*stderr tail:\n好x[\s\S]*formatter stdout/u,
    );
  });

  it("uses repository paths in write mode and temporary paths in check mode", () => {
    const calls = mockFormatter();

    expect(formatDocs({ root })).toEqual({ changed: [], fileCount: 2 });
    expect(formatDocs({ root, check: true })).toEqual({ changed: [], fileCount: 2 });

    expect(calls[0]?.args.slice(-2)).toEqual(["README.md", "docs/guide.mdx"]);
    const temporaryFiles = calls[1]?.args.slice(-2);
    expect(temporaryFiles?.every((file) => path.isAbsolute(file))).toBe(true);
    expect(temporaryFiles?.every((file) => file.startsWith(root))).toBe(false);
  });
});
