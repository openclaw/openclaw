import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDocs } from "../../scripts/format-docs.mts";
import { createScriptTestHarness } from "./test-helpers.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const { createTempDir } = createScriptTestHarness();

afterEach(() => {
  vi.mocked(spawnSync).mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function commandResult(stdout = "", stderr = "", status = 0): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null };
}

function writeDocsFixture(root: string, files = ["README.md", "docs/guide.mdx"]): void {
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "# Guide\n", "utf8");
  }
}

function mockFormatter(
  files: string[],
  run: (command: string, args: readonly string[]) => SpawnSyncReturns<string> = () =>
    commandResult(),
) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  vi.mocked(spawnSync).mockImplementation((command, args = []) => {
    if (command === "git") {
      return args[0] === "ls-files" ? commandResult(files.join("\n")) : commandResult("", "", 1);
    }
    calls.push({ command, args });
    return run(command, args);
  });
  return calls;
}

describe("format-docs", () => {
  it("wraps the Windows oxfmt.cmd shim through cmd.exe", () => {
    const root = createTempDir("openclaw-format-docs-windows-");
    writeDocsFixture(root);
    const shim = path.join(root, "node_modules", ".bin", "oxfmt.cmd");
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, "@echo off\n");
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const calls = mockFormatter(["README.md", "docs/guide.mdx"]);

    formatDocs({ root });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(calls[0]?.args[3]).toContain("oxfmt.cmd");
    expect(calls[0]?.args[3]).toContain("--write");
    expect(calls[0]?.args[3]).toContain("docs/guide.mdx");
    expect(spawnSync).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ shell: false, windowsVerbatimArguments: true }),
    );
  });

  it("batches oxfmt invocations without losing docs that exceed the command line budget", () => {
    const root = createTempDir("openclaw-format-docs-batch-");
    const files = Array.from({ length: 150 }, (_, index) => `docs/${index}-${"a".repeat(180)}.md`);
    writeDocsFixture(root, files);
    const calls = mockFormatter(files);

    formatDocs({ root });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.command === process.execPath)).toBe(true);
    expect(calls.flatMap((call) => call.args.slice(5))).toEqual(files);
  });

  it("reports git and oxfmt spawn diagnostics", () => {
    const root = createTempDir("openclaw-format-docs-failures-");
    writeDocsFixture(root);
    vi.mocked(spawnSync).mockReturnValue(commandResult("", "fatal: not a git repository", 128));
    expect(() => formatDocs({ root })).toThrow(
      /git ls-files failed:[\s\S]*exit status: 128[\s\S]*fatal: not a git repository/u,
    );

    mockFormatter(["README.md"], () => commandResult("formatter stdout", "formatter stderr", 1));
    expect(() => formatDocs({ root })).toThrow(
      /oxfmt failed:[\s\S]*command:[\s\S]*exit status: 1[\s\S]*formatter stderr[\s\S]*formatter stdout/u,
    );
  });

  it("keeps real formatter failure tails UTF-8 safe", async () => {
    const { spawnSync: realSpawnSync } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const root = createTempDir("openclaw-format-docs-utf8-tail-");
    writeDocsFixture(root);
    mockFormatter(["README.md"], () =>
      realSpawnSync(
        process.execPath,
        ["-e", 'process.stderr.write("你好" + "x".repeat(16_380)); process.exitCode = 1'],
        { encoding: "utf8", maxBuffer: 1024 * 1024, shell: false, timeout: 5_000 },
      ),
    );

    expect(() => formatDocs({ root })).toThrow(
      /oxfmt failed:[\s\S]*exit status: 1[\s\S]*stderr tail:\n好x/u,
    );
  });

  it("uses repository paths in write mode and temporary paths in check mode", () => {
    const root = createTempDir("openclaw-format-docs-mode-");
    writeDocsFixture(root);
    const calls = mockFormatter(["README.md", "docs/guide.mdx"]);

    expect(formatDocs({ root })).toEqual({ changed: [], fileCount: 2 });
    expect(formatDocs({ root, check: true })).toEqual({ changed: [], fileCount: 2 });

    expect(calls[0]?.args.slice(-2)).toEqual(["README.md", "docs/guide.mdx"]);
    const temporaryFiles = calls[1]?.args.slice(-2);
    expect(temporaryFiles?.every((file) => path.isAbsolute(file))).toBe(true);
    expect(temporaryFiles?.every((file) => file.startsWith(root))).toBe(false);
  });
});
