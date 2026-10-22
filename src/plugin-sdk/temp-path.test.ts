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
    ["line-media", ".jpg", "/tmp", 123, "abc", "line-media-123-abc.jpg"],
    ["archive", "tar.gz", "relative/tmp", 123.9, " abc ", "archive-123-abc.tar.gz"],
    ["../../channels/../media", "/../.jpg", undefined, 123, "abc", "channels-media-123-abc.jpg"],
  ] as const)("builds a safe %s path", (prefix, extension, tmpDir, now, uuid, basename) => {
    const result = buildRandomTempFilePath({ prefix, extension, tmpDir, now, uuid });
    expect(path.basename(result)).toBe(basename);
    if (tmpDir === undefined) {
      expectPathInsideTmpRoot(result);
    } else {
      expect(result).toBe(path.join(tmpDir, basename));
    }
  });

  it.each(["../../../escaped", "..\\..\\escaped", "id\0name"])(
    "rejects path-control bytes in the UUID override %j",
    (uuid) => {
      expect(() =>
        buildRandomTempFilePath({ prefix: "download", tmpDir: "/tmp/owned", now: 1, uuid }),
      ).toThrow(/safe path segment/);
    },
  );

  it("generates a UUID for a blank override", () => {
    const result = buildRandomTempFilePath({
      prefix: "media",
      now: 123,
      extension: ".jpg",
      uuid: "   ",
    });
    expect(path.basename(result)).toMatch(/^media-123-[\da-f-]{36}\.jpg$/u);
    expectPathInsideTmpRoot(result);
  });
});

it.each([
  ["default path and cleanup", "line-media", undefined, undefined],
  ["sanitized prefix and filename", "../../channels/../media", "../../evil.bin", "evil.bin"],
  ...[".", "../..", "-..-"].map(
    (fileName) => ["dot segment", "media", fileName, "download.bin"] as const,
  ),
] as const)("downloads safely: %s (%s, %s)", async (_name, prefix, fileName, expectedBasename) => {
  let capturedPath = "";
  await withTempDownloadPath({ prefix, fileName }, async (tmpPath) => {
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
