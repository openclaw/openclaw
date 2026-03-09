import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as archive from "./archive.js";
import { resolveExistingInstallPath, withExtractedArchiveRoot } from "./install-flow.js";
import * as installSource from "./install-source-utils.js";

describe("resolveExistingInstallPath", () => {
  let fixtureRoot = "";

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-flow-"));
  });

  afterEach(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("returns resolved path and stat for existing files", async () => {
    const filePath = path.join(fixtureRoot, "plugin.tgz");
    await fs.writeFile(filePath, "archive");

    const result = await resolveExistingInstallPath(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.resolvedPath).toBe(filePath);
    expect(result.stat.isFile()).toBe(true);
  });

  it("returns a path-not-found error for missing paths", async () => {
    const missing = path.join(fixtureRoot, "missing.tgz");

    const result = await resolveExistingInstallPath(missing);

    expect(result).toEqual({
      ok: false,
      error: `path not found: ${missing}`,
    });
  });
});

describe("withExtractedArchiveRoot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts archive and passes root directory to callback", async () => {
    const tmpRoot = path.join(path.sep, "tmp", "openclaw-install-flow");
    const archivePath = path.join(path.sep, "tmp", "plugin.tgz");
    const extractDir = path.join(tmpRoot, "extract");
    const packageRoot = path.join(extractDir, "package");
    const withTempDirSpy = vi
      .spyOn(installSource, "withTempDir")
      .mockImplementation(async (_prefix, fn) => await fn(tmpRoot));
    const extractSpy = vi.spyOn(archive, "extractArchive").mockResolvedValue(undefined);
    const resolveRootSpy = vi.spyOn(archive, "resolvePackedRootDir").mockResolvedValue(packageRoot);

    const onExtracted = vi.fn(async (rootDir: string) => ({ ok: true as const, rootDir }));
    const result = await withExtractedArchiveRoot({
      archivePath,
      tempDirPrefix: "openclaw-plugin-",
      timeoutMs: 1000,
      onExtracted,
    });

    expect(withTempDirSpy).toHaveBeenCalledWith("openclaw-plugin-", expect.any(Function));
    expect(extractSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        archivePath,
      }),
    );
    expect(resolveRootSpy).toHaveBeenCalledWith(extractDir);
    expect(onExtracted).toHaveBeenCalledWith(packageRoot);
    expect(result).toEqual({
      ok: true,
      rootDir: packageRoot,
    });
  });

  it("returns extract failure when extraction throws", async () => {
    vi.spyOn(installSource, "withTempDir").mockImplementation(
      async (_prefix, fn) => await fn("/tmp/openclaw-install-flow"),
    );
    vi.spyOn(archive, "extractArchive").mockRejectedValue(new Error("boom"));

    const result = await withExtractedArchiveRoot({
      archivePath: "/tmp/plugin.tgz",
      tempDirPrefix: "openclaw-plugin-",
      timeoutMs: 1000,
      onExtracted: async () => ({ ok: true as const }),
    });

    expect(result).toEqual({
      ok: false,
      error: "failed to extract archive: Error: boom",
    });
  });

  it("returns root-resolution failure when archive layout is invalid", async () => {
    vi.spyOn(installSource, "withTempDir").mockImplementation(
      async (_prefix, fn) => await fn("/tmp/openclaw-install-flow"),
    );
    vi.spyOn(archive, "extractArchive").mockResolvedValue(undefined);
    vi.spyOn(archive, "resolvePackedRootDir").mockRejectedValue(new Error("invalid layout"));

    const result = await withExtractedArchiveRoot({
      archivePath: "/tmp/plugin.tgz",
      tempDirPrefix: "openclaw-plugin-",
      timeoutMs: 1000,
      onExtracted: async () => ({ ok: true as const }),
    });

    expect(result).toEqual({
      ok: false,
      error: "Error: invalid layout",
    });
  });
});
