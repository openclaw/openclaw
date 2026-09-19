import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSqliteTranscriptArchivePath } from "./session-accessor.sqlite-archive-artifact.js";

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

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("registered transcript archive filenames", () => {
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-archive-name-"));
    sandboxes.push(dir);
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
    expect(fs.existsSync(archivePath)).toBe(true);
  });
});
