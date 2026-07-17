// Windows archive fsync must use a writable descriptor (#110152).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import { materializeSqliteSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-archive-"));
  tempDirs.push(dir);
  return dir;
}

describe("sqlite transcript archive durability", () => {
  it.runIf(process.platform === "win32")(
    "fsync on a read-only descriptor fails with EPERM on Windows",
    () => {
      const dir = makeTempDir();
      const filePath = path.join(dir, "readonly-fsync.tmp");
      fs.writeFileSync(filePath, Buffer.from("payload"), { flag: "wx", mode: 0o600 });

      const readOnlyFd = fs.openSync(filePath, "r");
      try {
        let thrown: unknown;
        try {
          fs.fsyncSync(readOnlyFd);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({
          code: "EPERM",
          errno: -4048,
          syscall: "fsync",
        });
      } finally {
        fs.closeSync(readOnlyFd);
      }

      const writableFd = fs.openSync(filePath, "r+");
      try {
        fs.fsyncSync(writableFd);
      } finally {
        fs.closeSync(writableFd);
      }
    },
  );

  it("materializes SQLite transcript archives through a writable fsync path", () => {
    const dir = makeTempDir();
    const content = `${JSON.stringify({ type: "message", body: "archive-fsync" })}\n`;
    const [plan] = materializeSqliteSessionStateDeletePlans([
      {
        archiveDirectory: dir,
        archiveTranscript: true,
        content,
        hadTranscriptState: true,
        reason: "deleted",
        sessionId: "archive-fsync-session",
      },
    ]);

    expect(plan.archivedTranscript?.archivedPath).toBeTruthy();
    const archivePath = plan.archivedTranscript!.archivedPath;
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(readSessionArchiveContentSync(archivePath)).toBe(content);
  });
});
