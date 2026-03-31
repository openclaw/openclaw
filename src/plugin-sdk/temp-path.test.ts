import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { buildRandomTempFilePath, withTempDownloadPath } from "./temp-path.js";

function expectPathInsideTmpRoot(resultPath: string) {
  const tmpRoot = path.resolve(resolvePreferredOpenClawTmpDir());
  const resolved = path.resolve(resultPath);
  const rel = path.relative(tmpRoot, resolved);
  expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
  expect(resultPath).not.toContain("..");
}

describe("buildRandomTempFilePath", () => {
  it.each([
    {
      name: "builds deterministic paths when now/uuid are provided",
      input: {
        prefix: "line-media",
        extension: ".jpg",
        tmpDir: "/tmp",
        now: 123,
        uuid: "abc",
      },
      expectedPath: path.join("/tmp", "line-media-123-abc.jpg"),
      expectedBasename: "line-media-123-abc.jpg",
      verifyInsideTmpRoot: false,
    },
    {
      name: "sanitizes prefix and extension to avoid path traversal segments",
      input: {
        prefix: "../../channels/../media",
        extension: "/../.jpg",
        now: 123,
        uuid: "abc",
      },
      expectedBasename: "channels-media-123-abc.jpg",
      verifyInsideTmpRoot: true,
    },
  ])("$name", ({ input, expectedPath, expectedBasename, verifyInsideTmpRoot }) => {
    const result = buildRandomTempFilePath(input);
    if (expectedPath) {
      expect(result).toBe(expectedPath);
    }
    expect(path.basename(result)).toBe(expectedBasename);
    if (verifyInsideTmpRoot) {
      expectPathInsideTmpRoot(result);
    }
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
    let capturedPath = "";
    await withTempDownloadPath(
      {
        prefix: "../../channels/../media",
        fileName: "../../evil.bin",
      },
      async (tmpPath) => {
        capturedPath = tmpPath;
      },
    );

    expectPathInsideTmpRoot(capturedPath);
    expect(path.basename(capturedPath)).toBe("evil.bin");
  });
});
