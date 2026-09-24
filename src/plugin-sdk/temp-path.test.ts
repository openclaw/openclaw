// Temp path tests cover plugin SDK temp directory creation and cleanup helpers.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { buildRandomTempFilePath, withTempDownloadPath } from "./temp-path.js";

function expectPathInsideTmpRoot(resultPath: string) {
  const tmpRoot = fsSync.realpathSync(resolvePreferredOpenClawTmpDir());
  let resolved = path.resolve(resultPath);
  try {
    resolved = path.join(fsSync.realpathSync(path.dirname(resultPath)), path.basename(resultPath));
  } catch {
    // The temp parent is intentionally gone after withTempDownloadPath cleanup.
  }
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
      name: "preserves relative roots, trimmed UUIDs, and compound extensions",
      input: {
        prefix: "archive",
        extension: "tar.gz",
        tmpDir: "relative/tmp",
        now: 123.9,
        uuid: " abc ",
      },
      expectedPath: path.join("relative/tmp", "archive-123-abc.tar.gz"),
      expectedBasename: "archive-123-abc.tar.gz",
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

  it.each(["../../../escaped", "..\\..\\escaped", "id/name", "id\0name"])(
    "rejects path-control bytes in the UUID override %j",
    (uuid) => {
      expect(() =>
        buildRandomTempFilePath({ prefix: "download", tmpDir: "/tmp/owned", now: 1, uuid }),
      ).toThrow(/safe path segment/);
    },
  );

  it.each(["", "   "])("generates a UUID for a blank override %j", (uuid) => {
    const result = buildRandomTempFilePath({ prefix: "media", now: 123, extension: ".jpg", uuid });
    expect(path.basename(result)).toMatch(/^media-123-[\da-f-]{36}\.jpg$/u);
    expectPathInsideTmpRoot(result);
  });
});

describe("withTempDownloadPath", () => {
  it.each([
    {
      name: "creates a temp path under tmp dir and cleans up the temp directory",
      input: { prefix: "line-media" },
      expectedBasename: undefined,
    },
    {
      name: "sanitizes prefix and fileName",
      input: { prefix: "../../channels/../media", fileName: "../../evil.bin" },
      expectedBasename: "evil.bin",
    },
    ...[".", "..", "../..", "-..-"].map((fileName) => ({
      name: `falls back to the default name for the dot segment ${fileName}`,
      input: { prefix: "media", fileName },
      expectedBasename: "download.bin",
    })),
  ])("$name", async ({ input, expectedBasename }) => {
    let capturedPath = "";
    await withTempDownloadPath(input, async (tmpPath) => {
      capturedPath = tmpPath;
      await fs.writeFile(tmpPath, "ok");
    });

    expectPathInsideTmpRoot(capturedPath);
    if (expectedBasename) {
      expect(path.basename(capturedPath)).toBe(expectedBasename);
    } else {
      expect(capturedPath).toContain(path.join(resolvePreferredOpenClawTmpDir(), "line-media-"));
    }
    await expect(fs.stat(path.dirname(capturedPath))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
