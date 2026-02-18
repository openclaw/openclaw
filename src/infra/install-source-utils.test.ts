import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  packNpmSpecToArchive,
  resolveArchiveSourcePath,
  withTempDir,
} from "./install-source-utils.js";

const runCommandWithTimeoutMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

const tempDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      break;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("withTempDir", () => {
  it("creates a temp dir and always removes it after callback", async () => {
    let observedDir = "";
    const markerFile = "marker.txt";

    const value = await withTempDir("openclaw-install-source-utils-", async (tmpDir) => {
      observedDir = tmpDir;
      await fs.writeFile(path.join(tmpDir, markerFile), "ok", "utf-8");
      await expect(fs.stat(path.join(tmpDir, markerFile))).resolves.toBeDefined();
      return "done";
    });

    expect(value).toBe("done");
    await expect(fs.stat(observedDir)).rejects.toThrow();
  });
});

describe("resolveArchiveSourcePath", () => {
  it("returns not found error for missing archive paths", async () => {
    const result = await resolveArchiveSourcePath("/tmp/does-not-exist-openclaw-archive.tgz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("archive not found");
    }
  });

  it("rejects unsupported archive extensions", async () => {
    const dir = await createTempDir("openclaw-install-source-utils-");
    const filePath = path.join(dir, "plugin.txt");
    await fs.writeFile(filePath, "not-an-archive", "utf-8");

    const result = await resolveArchiveSourcePath(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsupported archive");
    }
  });

  it("accepts supported archive extensions", async () => {
    const dir = await createTempDir("openclaw-install-source-utils-");
    const filePath = path.join(dir, "plugin.zip");
    await fs.writeFile(filePath, "", "utf-8");

    const result = await resolveArchiveSourcePath(filePath);
    expect(result).toEqual({ ok: true, path: filePath });
  });
});

describe("packNpmSpecToArchive", () => {
  it("packs spec and returns archive path using the final non-empty stdout line", async () => {
    const cwd = await createTempDir("openclaw-install-source-utils-");
    runCommandWithTimeoutMock.mockResolvedValue({
      stdout: "npm notice created package\nopenclaw-plugin-1.2.3.tgz\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    const result = await packNpmSpecToArchive({
      spec: "openclaw-plugin@1.2.3",
      timeoutMs: 1000,
      cwd,
    });

    expect(result).toEqual({
      ok: true,
      archivePath: path.join(cwd, "openclaw-plugin-1.2.3.tgz"),
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["npm", "pack", "openclaw-plugin@1.2.3", "--ignore-scripts"],
      expect.objectContaining({
        cwd,
        timeoutMs: 300_000,
      }),
    );
  });

  it("returns npm pack error details when command fails", async () => {
    const cwd = await createTempDir("openclaw-install-source-utils-");
    runCommandWithTimeoutMock.mockResolvedValue({
      stdout: "fallback stdout",
      stderr: "registry timeout",
      code: 1,
      signal: null,
      killed: false,
    });

    const result = await packNpmSpecToArchive({
      spec: "bad-spec",
      timeoutMs: 5000,
      cwd,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("npm pack failed");
      expect(result.error).toContain("registry timeout");
    }
  });

  it("returns explicit error when npm pack produces no archive name", async () => {
    const cwd = await createTempDir("openclaw-install-source-utils-");
    runCommandWithTimeoutMock.mockResolvedValue({
      stdout: " \n\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    const result = await packNpmSpecToArchive({
      spec: "openclaw-plugin@1.2.3",
      timeoutMs: 5000,
      cwd,
    });

    expect(result).toEqual({
      ok: false,
      error: "npm pack produced no archive",
    });
  });
});
