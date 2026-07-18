import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeLocalizationCatalogRevision,
  listRegularFiles,
} from "../../scripts/lib/localization-catalog-revision.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("localization catalog revision", () => {
  it("hashes sorted repository-relative paths and content", () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, "catalog"));
    fs.writeFileSync(path.join(root, "catalog", "b.txt"), "second");
    fs.writeFileSync(path.join(root, "catalog", "a.txt"), "first");

    const first = computeLocalizationCatalogRevision(root, ["catalog"]);
    const second = computeLocalizationCatalogRevision(root, ["catalog"]);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(second).toBe(first);
  });

  it("rejects symlinks instead of producing platform-dependent revisions", () => {
    const root = createTempDir();
    const target = path.join(root, "target");
    const link = path.join(root, "catalog");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "message.txt"), "hello");
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

    expect(() => listRegularFiles(link)).toThrow("cannot contain symlinks");
  });
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-localization-"));
  tempDirs.push(tempDir);
  return tempDir;
}
