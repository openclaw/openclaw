import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { buildRandomTempFilePath, withTempDownloadPath } from "./temp-path.js";

describe("buildRandomTempFilePath", () => {
  it("builds deterministic paths when now/uuid are provided", () => {
    const result = buildRandomTempFilePath({
      prefix: "line-media",
      extension: ".jpg",
      tmpDir: "/tmp",
      now: 123,
      uuid: "abc",
    });
    expect(result).toBe(path.join("/tmp", "line-media-123-abc.jpg"));
  });

  it("sanitizes prefix and extension to avoid path traversal segments", () => {
    const tmpRoot = path.resolve(resolvePreferredOpenClawTmpDir());
    const result = buildRandomTempFilePath({
      prefix: "../../line/../media",
      extension: "/../.jpg",
      now: 123,
      uuid: "abc",
    });
    const resolved = path.resolve(result);
    const rel = path.relative(tmpRoot, resolved);
    expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.basename(result)).toBe("line-media-123-abc.jpg");
    expect(result).not.toContain("..");
  });
});

describe("withTempDownloadPath", () => {
  it("creates a temp path under tmp dir and cleans up the temp directory", async () => {
    let capturedPath = "";
    await withTempDownloadPath(
      {
        prefix: "line-media",
      },
      async (tmpPath) => {
        capturedPath = tmpPath;
        await fs.writeFile(tmpPath, "ok");
      },
    );

    expect(capturedPath).toContain(path.join(resolvePreferredOpenClawTmpDir(), "line-media-"));
    await expect(fs.stat(capturedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sanitizes prefix and fileName", async () => {
    const tmpRoot = path.resolve(resolvePreferredOpenClawTmpDir());
    let capturedPath = "";
    await withTempDownloadPath(
      {
        prefix: "../../line/../media",
        fileName: "../../evil.bin",
      },
      async (tmpPath) => {
        capturedPath = tmpPath;
      },
    );

    const resolved = path.resolve(capturedPath);
    const rel = path.relative(tmpRoot, resolved);
    expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.basename(capturedPath)).toBe("evil.bin");
    expect(capturedPath).not.toContain("..");
  });
});
