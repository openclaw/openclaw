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
const TEMP_DIR_PREFIX = "openclaw-install-source-utils-";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

const tempDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createFixtureDir() {
  return await createTempDir(TEMP_DIR_PREFIX);
}

async function createFixtureFile(params: {
  fileName: string;
  contents: string;
  dir?: string;
}): Promise<{ dir: string; filePath: string }> {
  const dir = params.dir ?? (await createFixtureDir());
  const filePath = path.join(dir, params.fileName);
  await fs.writeFile(filePath, params.contents, "utf-8");
  return { dir, filePath };
}

function mockPackCommandResult(params: { stdout: string; stderr?: string; code?: number }) {
  runCommandWithTimeoutMock.mockResolvedValue({
    stdout: params.stdout,
    stderr: params.stderr ?? "",
    code: params.code ?? 0,
    signal: null,
    killed: false,
  });
}

async function runPack(spec: string, cwd: string, timeoutMs = 1000) {
  return await packNpmSpecToArchive({
    spec,
    timeoutMs,
    cwd,
  });
}

beforeEach(() => {
  runCommandWithTimeoutMock.mockClear();
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
    const { filePath } = await createFixtureFile({
      fileName: "plugin.txt",
      contents: "not-an-archive",
    });

    const result = await resolveArchiveSourcePath(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsupported archive");
    }
  });

  it("accepts supported archive extensions", async () => {
    const { filePath } = await createFixtureFile({
      fileName: "plugin.zip",
      contents: "",
    });

    const result = await resolveArchiveSourcePath(filePath);
    expect(result).toEqual({ ok: true, path: filePath });
  });
});

describe("packNpmSpecToArchive", () => {
  it("packs spec and returns archive path using JSON output metadata", async () => {
    const cwd = await createFixtureDir();
    const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(archivePath, "", "utf-8");
    mockPackCommandResult({
      stdout: JSON.stringify([
        {
          id: "openclaw-plugin@1.2.3",
          name: "openclaw-plugin",
          version: "1.2.3",
          filename: "openclaw-plugin-1.2.3.tgz",
          integrity: "sha512-test-integrity",
          shasum: "abc123",
        },
      ]),
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd);

    expect(result).toEqual({
      ok: true,
      archivePath,
      metadata: {
        name: "openclaw-plugin",
        version: "1.2.3",
        resolvedSpec: "openclaw-plugin@1.2.3",
        integrity: "sha512-test-integrity",
        shasum: "abc123",
      },
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["npm", "pack", "openclaw-plugin@1.2.3", "--ignore-scripts", "--json"],
      expect.objectContaining({
        cwd,
        timeoutMs: 300_000,
      }),
    );
  });

  it("falls back to parsing final stdout line when npm json output is unavailable", async () => {
    const cwd = await createFixtureDir();
    const expectedArchivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(expectedArchivePath, "", "utf-8");
    mockPackCommandResult({
      stdout: "npm notice created package\nopenclaw-plugin-1.2.3.tgz\n",
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd);

    expect(result).toEqual({
      ok: true,
      archivePath: expectedArchivePath,
      metadata: {},
    });
  });

  it("returns npm pack error details when command fails", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: "fallback stdout",
      stderr: "registry timeout",
      code: 1,
    });

    const result = await runPack("bad-spec", cwd, 5000);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("npm pack failed");
      expect(result.error).toContain("registry timeout");
    }
  });

  it("falls back to archive detected in cwd when npm pack stdout is empty", async () => {
    const cwd = await createTempDir("openclaw-install-source-utils-");
    const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(archivePath, "", "utf-8");
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
      ok: true,
      archivePath,
      metadata: {},
    });
  });

  it("falls back to archive detected in cwd when stdout does not contain a tgz", async () => {
    const cwd = await createTempDir("openclaw-install-source-utils-");
    const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(archivePath, "", "utf-8");
    runCommandWithTimeoutMock.mockResolvedValue({
      stdout: "npm pack completed successfully\n",
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
      ok: true,
      archivePath,
      metadata: {},
    });
  });

  it("returns explicit error when npm pack produces no archive name", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: " \n\n",
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd, 5000);

    expect(result).toEqual({
      ok: false,
      error: "npm pack produced no archive",
    });
  });

  it("parses scoped metadata from id-only json output even with npm notice prefix", async () => {
    const cwd = await createFixtureDir();
    await fs.writeFile(path.join(cwd, "openclaw-plugin-demo-2.0.0.tgz"), "", "utf-8");
    mockPackCommandResult({
      stdout:
        "npm notice creating package\n" +
        JSON.stringify([
          {
            id: "@openclaw/plugin-demo@2.0.0",
            filename: "openclaw-plugin-demo-2.0.0.tgz",
          },
        ]),
    });

    const result = await runPack("@openclaw/plugin-demo@2.0.0", cwd);
    expect(result).toEqual({
      ok: true,
      archivePath: path.join(cwd, "openclaw-plugin-demo-2.0.0.tgz"),
      metadata: {
        resolvedSpec: "@openclaw/plugin-demo@2.0.0",
      },
    });
  });

  it("uses stdout fallback error text when stderr is empty", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: "network timeout",
      stderr: " ",
      code: 1,
    });

    const result = await runPack("bad-spec", cwd);
    expect(result).toEqual({
      ok: false,
      error: "npm pack failed: network timeout",
    });
  });
});
