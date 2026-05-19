import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import {
  archiveFileOnDisk,
  archiveSessionTranscriptsDetailed,
} from "./session-transcript-files.fs.js";

const subscriptions: Array<() => void> = [];

afterEach(() => {
  while (subscriptions.length > 0) {
    subscriptions.pop()?.();
  }
});

describe("archiveFileOnDisk transcript updates", () => {
  it("emits a session transcript update for the archived path on reset", () => {
    const updates: SessionTranscriptUpdate[] = [];
    subscriptions.push(onSessionTranscriptUpdate((update) => updates.push(update)));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-events-reset-"));
    try {
      const sessionFile = path.join(tmpDir, "live.jsonl");
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');

      const archived = archiveFileOnDisk(sessionFile, "reset");

      expect(fs.existsSync(archived)).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(false);
      expect(archived).toContain(".jsonl.reset.");
      expect(updates).toHaveLength(1);
      expect(updates[0].sessionFile).toBe(archived);
      // Archive does not carry a messageId/message payload — this is a
      // pure-path mutation notification, matching how compaction-only
      // emits (sessionFile + sessionKey-only) behave.
      expect(updates[0].message).toBeUndefined();
      expect(updates[0].messageId).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("also emits for deleted and bak archive reasons", () => {
    const updates: SessionTranscriptUpdate[] = [];
    subscriptions.push(onSessionTranscriptUpdate((update) => updates.push(update)));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-events-mixed-"));
    try {
      const deletedSource = path.join(tmpDir, "deleted.jsonl");
      fs.writeFileSync(deletedSource, "{}\n");
      const deletedArchived = archiveFileOnDisk(deletedSource, "deleted");

      const bakSource = path.join(tmpDir, "bak.jsonl");
      fs.writeFileSync(bakSource, "{}\n");
      const bakArchived = archiveFileOnDisk(bakSource, "bak");

      expect(deletedArchived).toContain(".jsonl.deleted.");
      expect(bakArchived).toContain(".jsonl.bak.");
      expect(updates.map((update) => update.sessionFile)).toEqual([deletedArchived, bakArchived]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("archiveSessionTranscriptsDetailed failure surface (#81984)", () => {
  it("invokes onArchiveError when fs.renameSync fails and still returns successful entries", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-failure-"));
    try {
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');

      const renameError = Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
        throw renameError;
      });

      const errors: Array<{ err: unknown; sourcePath: string }> = [];
      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
        onArchiveError: (err, sourcePath) => {
          errors.push({ err, sourcePath });
        },
      });

      renameSpy.mockRestore();

      expect(archived).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].err).toBe(renameError);
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("archives normally when no onArchiveError is provided", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-success-"));
    try {
      const sessionId = "22222222-2222-4222-8222-222222222222";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
      });

      expect(archived.length).toBe(1);
      expect(archived[0].archivedPath).toContain(".jsonl.reset.");
      expect(fs.existsSync(archived[0].archivedPath)).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("surfaces a REAL EACCES (chmod 0o555 parent dir) through onArchiveError, no fs spy", () => {
    // clawsweeper feedback on PR #82081: the failure-surface assertion used a
    // spy on fs.renameSync. This case removes the spy entirely and induces the
    // EACCES on a real macOS/Linux filesystem by chmod'ing the parent dir to
    // 0o555 (read+execute, no write) so the in-place sibling rename that
    // archiveSessionTranscriptsDetailed performs hits the real kernel errno.
    if (process.platform === "win32") {
      return;
    }
    // realpath resolves the /var → /private/var symlink macOS uses for tmp, so
    // the assertion against errors[0].sourcePath compares the same shape the
    // production code would emit.
    const tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-real-eaccess-")),
    );
    try {
      const sessionId = "33333333-3333-4333-8333-333333333333";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');

      // Real, on-disk EACCES — no module mocks anywhere in this test.
      fs.chmodSync(tmpDir, 0o555);

      const errors: Array<{ code?: string; sourcePath: string }> = [];
      let archived: ReturnType<typeof archiveSessionTranscriptsDetailed>;
      try {
        archived = archiveSessionTranscriptsDetailed({
          sessionId,
          storePath: path.join(tmpDir, "store.json"),
          sessionFile,
          agentId: "main",
          reason: "reset",
          onArchiveError: (err, sourcePath) => {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            errors.push({ code, sourcePath });
          },
        });
      } finally {
        // Restore writeable mode so afterEach cleanup can rmSync the dir.
        fs.chmodSync(tmpDir, 0o755);
      }

      expect(archived).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
      // The exact errno depends on platform/fs; EACCES on macOS/Linux,
      // sometimes EPERM elsewhere. Assert the source path is the real session
      // file and the error carries a system errno (i.e. it's not synthesised).
      expect(errors[0].sourcePath).toBe(sessionFile);
      expect(errors[0].code).toMatch(/^(EACCES|EPERM)$/);
      // The original session file is left in place when the archive rename
      // fails, so downstream code can retry on the next /new rotation.
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      try {
        fs.chmodSync(tmpDir, 0o755);
      } catch {
        // already restored
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
