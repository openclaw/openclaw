import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectFilesSync,
  isCodeFile,
  listRepoFilesSync,
  relativeToCwd,
  toPosixPath,
} from "../../scripts/check-file-utils.js";
import { createScriptTestHarness } from "./test-helpers.js";

const execFileSyncMock = vi.hoisted(() => vi.fn(() => ""));

vi.mock("node:child_process", async (importOriginal) => {
  const original = (await importOriginal()) as typeof import("node:child_process");
  return { ...original, execFileSync: execFileSyncMock };
});

const { createTempDir } = createScriptTestHarness();
function fixture(...files: string[]) {
  const root = createTempDir("openclaw-check-file-utils-");
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "");
  }
  return root;
}
const includeFile = (file: string) => file.endsWith(".ts");

describe("scripts/check-file-utils", () => {
  afterEach(() => execFileSyncMock.mockReset());
  it.each([
    {
      name: "common generated dirs",
      skipped: ["dist/skip.ts", "docs/.generated/skip.ts"],
      skipDirNames: undefined,
    },
    {
      name: "custom skipped directories",
      skipped: ["fixtures/skip.ts"],
      skipDirNames: new Set(["fixtures"]),
    },
  ])("collects matching files while skipping $name", ({ skipped, skipDirNames }) => {
    const kept = ["src/keep.ts", "src/nested/keep.test.ts"];
    const root = fixture(...kept, ...skipped);
    const files = collectFilesSync(root, { includeFile, skipDirNames })
      .map((file) => toPosixPath(path.relative(root, file)))
      .toSorted((a, b) => a.localeCompare(b));
    expect(files).toEqual(kept);
  });

  it("renders repo-relative paths when possible", () => {
    expect(relativeToCwd(path.join(process.cwd(), "scripts", "check-file-utils.ts"))).toBe(
      "scripts/check-file-utils.ts",
    );
  });

  it("filters tracked source files and bounds the git lookup", () => {
    execFileSyncMock.mockReturnValue("src/keep.ts\nsrc/keep.mjs\nsrc/skip.d.ts\n");

    expect(listRepoFilesSync("/fake/repo", { includeFile: isCodeFile })).toEqual([
      "src/keep.mjs",
      "src/keep.ts",
    ]);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["-C", "/fake/repo", "ls-files", "--"]),
      expect.objectContaining({
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  });

  it("falls back to filesystem traversal when git ls-files times out", () => {
    const error: NodeJS.ErrnoException & { signal?: string } = new Error("Command timed out");
    error.code = "ETIMEDOUT";
    error.signal = "SIGKILL";
    execFileSyncMock.mockImplementation(() => {
      throw error;
    });
    const rootDir = fixture("src/keep.ts");

    expect(listRepoFilesSync(rootDir, { includeFile })).toEqual(["src/keep.ts"]);
  });
});
