import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-path.js";

describe("archive path helpers", () => {
  it("uses custom escape labels in traversal errors", () => {
    expect(() =>
      validateArchiveEntryPath("../escape.txt", {
        escapeLabel: "targetDir",
      }),
    ).toThrow("archive entry escapes targetDir: ../escape.txt");
  });

  it("preserves strip-induced traversal for follow-up validation", () => {
    const stripped = stripArchivePath("a/../escape.txt", 1);
    expect(stripped).toBe("../escape.txt");
    expect(() =>
      validateArchiveEntryPath(stripped ?? "", {
        escapeLabel: "targetDir",
      }),
    ).toThrow("archive entry escapes targetDir: ../escape.txt");
  });

  it("keeps resolved output paths inside the root", () => {
    const rootDir = path.join(path.sep, "tmp", "archive-root");
    const safe = resolveArchiveOutputPath({
      rootDir,
      relPath: "sub/file.txt",
      originalPath: "sub/file.txt",
    });
    expect(safe).toBe(path.resolve(rootDir, "sub/file.txt"));

    expect(() =>
      resolveArchiveOutputPath({
        rootDir,
        relPath: "../escape.txt",
        originalPath: "../escape.txt",
        escapeLabel: "targetDir",
      }),
    ).toThrow("archive entry escapes targetDir: ../escape.txt");
  });
});
