import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  publishEncodedSessionTranscriptArchive,
  resolveSqliteTranscriptArchivePath,
  writeTranscriptArchive,
} from "./session-accessor.sqlite-archive-artifact.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function archiveInput() {
  const bytes = Buffer.from("retained transcript\n");
  return {
    archiveDirectory: tempDirs.make("openclaw-archive-publication-"),
    archiveName: "session.jsonl",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("encoded transcript archive publication", () => {
  it("verifies and reuses highly compressed archives against their source byte count", () => {
    const { archiveDirectory } = archiveInput();
    const content = "x".repeat(2 * 1024 * 1024);
    const input = { archiveDirectory, content, sessionId: "high-expansion" };
    const archivePath = writeTranscriptArchive(input);
    expect(
      zstdDecompressSync(fs.readFileSync(archivePath), {
        maxOutputLength: Buffer.byteLength(content),
      }).toString("utf8"),
    ).toBe(content);
    expect(writeTranscriptArchive(input)).toBe(archivePath);
  });

  it.each(["writeFileSync", "fsyncSync"] as const)(
    "cleans its unpublished temporary file when %s fails",
    (operation) => {
      const input = archiveInput();
      const failure = Object.assign(new Error("archive storage is full"), { code: "ENOSPC" });
      vi.spyOn(fs, operation).mockImplementationOnce(() => {
        throw failure;
      });

      expect(() => publishEncodedSessionTranscriptArchive(input)).toThrow(failure);
      expect(fs.readdirSync(input.archiveDirectory)).toEqual([]);

      const archivePath = publishEncodedSessionTranscriptArchive(input);
      expect(fs.readFileSync(archivePath)).toEqual(input.bytes);
      expect(fs.readdirSync(input.archiveDirectory)).toEqual([input.archiveName]);
    },
  );

  it("preserves a colliding temporary file that it did not create", () => {
    const input = archiveInput();
    const originalOpen = fs.openSync;
    const priorBytes = Buffer.from("another publisher's temporary bytes");
    let collisionPath = "";
    vi.spyOn(fs, "openSync").mockImplementationOnce((filePath, flags, mode) => {
      collisionPath = filePath.toString();
      fs.writeFileSync(filePath, priorBytes);
      return originalOpen(filePath, flags, mode);
    });

    expect(() => publishEncodedSessionTranscriptArchive(input)).toThrow(/EEXIST/);
    expect(fs.readFileSync(collisionPath)).toEqual(priorBytes);
    expect(fs.readdirSync(input.archiveDirectory)).toEqual([path.basename(collisionPath)]);
  });
});

describe("registered transcript archive filenames", () => {
  const ISSUE_SESSION_ID = "agent:main:kv-prefix-marker-final-20260913";

  function registryComponent(sessionId: string): string {
    const archivePath = resolveSqliteTranscriptArchivePath({
      archiveDirectory: path.join("archives"),
      generation: "test",
      identityOwner: "registry",
      reason: "deleted",
      sessionId,
      nowMs: 1_700_000_000_000,
    });
    return path.basename(archivePath).split(".jsonl.")[0] ?? "";
  }

  function expectedHashComponent(sessionId: string): string {
    return `session-${createHash("sha256").update(sessionId).digest("hex")}`;
  }

  it("hashes session ids containing Windows-illegal characters", () => {
    expect(registryComponent(ISSUE_SESSION_ID)).toBe(expectedHashComponent(ISSUE_SESSION_ID));
  });

  it("leaves short filesystem-safe ids untouched", () => {
    expect(registryComponent("agent-main-session-1")).toBe("agent-main-session-1");
  });

  it("keeps hashing overlong ids", () => {
    const longId = `s-${"x".repeat(200)}`;
    expect(registryComponent(longId)).toBe(expectedHashComponent(longId));
  });

  it("hashes Windows reserved device names with or without extension", () => {
    for (const reserved of ["NUL", "nul.txt", "COM1", "aux", "LPT9.log"]) {
      expect(registryComponent(reserved)).toBe(expectedHashComponent(reserved));
    }
    expect(registryComponent("NULL")).toBe("NULL");
  });

  it("hashes every other Windows-illegal character", () => {
    for (const id of ["a<b", "a>b", 'a"b', "a\\b", "a|b", "a?b", "a*b", "a\tb"]) {
      expect(registryComponent(id)).toBe(expectedHashComponent(id));
    }
  });

  it("leaves slashes raw so the outside-directory guard keeps rejecting them", () => {
    expect(() => registryComponent("a/b")).toThrow("Cannot archive SQLite transcript outside");
  });

  it("materializes the hashed archive file for a colon session id", () => {
    const dir = tempDirs.make("openclaw-archive-name-");
    const archivePath = resolveSqliteTranscriptArchivePath({
      archiveDirectory: dir,
      generation: "test",
      identityOwner: "registry",
      reason: "deleted",
      sessionId: ISSUE_SESSION_ID,
      nowMs: 1_700_000_000_000,
    });
    expect(path.dirname(archivePath)).toBe(path.resolve(dir));
    const fd = fs.openSync(archivePath, "wx");
    try {
      fs.writeFileSync(fd, "[]");
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.readFileSync(archivePath, "utf8")).toBe("[]");
  });
});
