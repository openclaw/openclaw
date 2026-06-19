// Transcript archive event tests ensure file archive/delete operations emit
// path-only transcript update notifications for UI and index listeners.
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

function writeTrajectoryPointer(pointerFile: string, sessionId: string, runtimeFile: string): void {
  fs.writeFileSync(
    pointerFile,
    `${JSON.stringify({
      traceSchema: "openclaw-trajectory-pointer",
      schemaVersion: 1,
      sessionId,
      runtimeFile,
    })}\n`,
  );
}

function writeTrajectoryRuntime(filePath: string, sessionId: string): void {
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      source: "runtime",
      sessionId,
    })}\n`,
  );
}

function writeSessionMeta(filePath: string, agentId: string): void {
  fs.writeFileSync(filePath, `${JSON.stringify({ type: "session-meta", agentId })}\n`);
}

const subscriptions: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
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

describe("archiveSessionTranscriptsDetailed failure surface", () => {
  it("invokes onArchiveError when fs.renameSync fails and returns only successful entries", () => {
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

  it("preserves the sibling trajectory and pointer on reset", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-trajectory-reset-"));
    try {
      const sessionId = "44444444-4444-4444-8444-444444444444";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const trajectoryFile = path.join(tmpDir, `${sessionId}.trajectory.jsonl`);
      const pointerFile = path.join(tmpDir, `${sessionId}.trajectory-path.json`);
      writeSessionMeta(sessionFile, "main");
      writeTrajectoryRuntime(trajectoryFile, sessionId);
      writeTrajectoryPointer(pointerFile, sessionId, trajectoryFile);

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
      });

      // Transcript + runtime + pointer = 3 archived entries.
      // The live trajectory artifacts are renamed, not deleted, so post-reset
      // forensics can still read the assistant's tool calls/results (#90707).
      expect(archived).toHaveLength(3);
      expect(fs.existsSync(trajectoryFile)).toBe(false);
      expect(fs.existsSync(pointerFile)).toBe(false);
      const remaining = fs.readdirSync(tmpDir);
      expect(remaining.some((name) => name.includes(".trajectory.jsonl.reset."))).toBe(true);
      expect(remaining.some((name) => name.includes(".trajectory-path.json.reset."))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not archive trajectory siblings for a deleted session", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-trajectory-deleted-"));
    try {
      const sessionId = "55555555-5555-4555-8555-555555555555";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const trajectoryFile = path.join(tmpDir, `${sessionId}.trajectory.jsonl`);
      const pointerFile = path.join(tmpDir, `${sessionId}.trajectory-path.json`);
      writeSessionMeta(sessionFile, "main");
      writeTrajectoryRuntime(trajectoryFile, sessionId);
      writeTrajectoryPointer(pointerFile, sessionId, trajectoryFile);

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "deleted",
      });

      expect(archived).toHaveLength(1);
      // A deleted/pruned session still owns the trajectory removal path, so the
      // archive step must leave the live siblings untouched.
      expect(fs.existsSync(trajectoryFile)).toBe(true);
      expect(fs.existsSync(pointerFile)).toBe(true);
      const remaining = fs.readdirSync(tmpDir);
      expect(remaining.some((name) => name.includes(".trajectory.jsonl.reset."))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("archives pointer-resolved runtime files from OPENCLAW_TRAJECTORY_DIR on reset", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-trajectory-override-"));
    const previousTrajectoryDir = process.env.OPENCLAW_TRAJECTORY_DIR;
    try {
      const sessionId = "66666666-6666-4666-8666-666666666666";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const trajectoryDir = path.join(tmpDir, "traces");
      const overrideRuntime = path.join(trajectoryDir, `${sessionId}.jsonl`);
      const pointerFile = path.join(tmpDir, `${sessionId}.trajectory-path.json`);
      fs.mkdirSync(trajectoryDir, { recursive: true });
      process.env.OPENCLAW_TRAJECTORY_DIR = trajectoryDir;
      writeSessionMeta(sessionFile, "main");
      writeTrajectoryRuntime(overrideRuntime, sessionId);
      writeTrajectoryPointer(pointerFile, sessionId, overrideRuntime);

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
      });

      // Transcript + override runtime + pointer = 3 archived entries.
      expect(archived).toHaveLength(3);
      expect(fs.existsSync(overrideRuntime)).toBe(false);
      expect(fs.existsSync(pointerFile)).toBe(false);
      const remaining = fs.readdirSync(trajectoryDir);
      expect(remaining.some((name) => name.includes(".jsonl.reset."))).toBe(true);
    } finally {
      if (previousTrajectoryDir === undefined) {
        delete process.env.OPENCLAW_TRAJECTORY_DIR;
      } else {
        process.env.OPENCLAW_TRAJECTORY_DIR = previousTrajectoryDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("archives the env-free sibling trajectory when OPENCLAW_TRAJECTORY_DIR is enabled after the session was created (#90707)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-trajectory-envchange-"));
    const previousTrajectoryDir = process.env.OPENCLAW_TRAJECTORY_DIR;
    try {
      const sessionId = "77777777-7777-4777-8777-777777777777";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      // The trajectory + pointer were written beside the transcript while no
      // override was configured.
      const siblingRuntime = path.join(tmpDir, `${sessionId}.trajectory.jsonl`);
      const pointerFile = path.join(tmpDir, `${sessionId}.trajectory-path.json`);
      writeSessionMeta(sessionFile, "main");
      writeTrajectoryRuntime(siblingRuntime, sessionId);
      writeTrajectoryPointer(pointerFile, sessionId, siblingRuntime);

      // The override is only enabled now, so the current-env default runtime
      // path points into an empty traces directory.
      const trajectoryDir = path.join(tmpDir, "traces");
      fs.mkdirSync(trajectoryDir, { recursive: true });
      process.env.OPENCLAW_TRAJECTORY_DIR = trajectoryDir;

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
      });

      // Transcript + env-free sibling runtime + pointer = 3 archived entries.
      expect(archived).toHaveLength(3);
      expect(fs.existsSync(siblingRuntime)).toBe(false);
      expect(fs.existsSync(pointerFile)).toBe(false);
      const remaining = fs.readdirSync(tmpDir);
      expect(remaining.some((name) => name.includes(".trajectory.jsonl.reset."))).toBe(true);
      expect(remaining.some((name) => name.includes(".trajectory-path.json.reset."))).toBe(true);
    } finally {
      if (previousTrajectoryDir === undefined) {
        delete process.env.OPENCLAW_TRAJECTORY_DIR;
      } else {
        process.env.OPENCLAW_TRAJECTORY_DIR = previousTrajectoryDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("surfaces real chmod archive failures through onArchiveError", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }

    const tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-real-eacces-")),
    );
    try {
      const sessionId = "33333333-3333-4333-8333-333333333333";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');
      fs.chmodSync(tmpDir, 0o555);

      const errors: Array<{ code?: string; sourcePath: string }> = [];
      let archived: ReturnType<typeof archiveSessionTranscriptsDetailed> = [];
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
        fs.chmodSync(tmpDir, 0o755);
      }

      expect(archived).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].sourcePath).toBe(sessionFile);
      expect(errors[0].code).toMatch(/^(EACCES|EPERM)$/);
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      try {
        fs.chmodSync(tmpDir, 0o755);
      } catch {
        // Already restored.
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not archive a pointer-resolved runtime file with a non-trajectory basename", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-trajectory-basename-"));
    try {
      const sessionId = "77777777-7777-4777-8777-777777777777";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const trajectoryFile = path.join(tmpDir, `${sessionId}.trajectory.jsonl`);
      const pointerFile = path.join(tmpDir, `${sessionId}.trajectory-path.json`);
      const unrelatedFile = path.join(tmpDir, "unrelated-data.jsonl");
      writeSessionMeta(sessionFile, "main");
      writeTrajectoryRuntime(trajectoryFile, sessionId);
      writeTrajectoryRuntime(unrelatedFile, sessionId);
      writeTrajectoryPointer(pointerFile, sessionId, unrelatedFile);

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
      });

      // Transcript + default runtime + pointer. The pointer-resolved file is
      // skipped because its basename does not match.
      expect(archived).toHaveLength(3);
      expect(fs.existsSync(unrelatedFile)).toBe(true);
      expect(fs.existsSync(trajectoryFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not archive a pointer-resolved runtime file lacking a session event header", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-trajectory-header-"));
    try {
      const sessionId = "88888888-8888-4888-8888-888888888888";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const trajectoryFile = path.join(tmpDir, `${sessionId}.trajectory.jsonl`);
      const pointerFile = path.join(tmpDir, `${sessionId}.trajectory-path.json`);
      const altDir = path.join(tmpDir, "alt");
      fs.mkdirSync(altDir, { recursive: true });
      const fakeRuntime = path.join(altDir, `${sessionId}.jsonl`);
      fs.writeFileSync(fakeRuntime, '{"traceSchema":"openclaw-trajectory","source":"runtime"}\n');
      writeSessionMeta(sessionFile, "main");
      writeTrajectoryRuntime(trajectoryFile, sessionId);
      writeTrajectoryPointer(pointerFile, sessionId, fakeRuntime);

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
      });

      // Transcript + default runtime + pointer. The pointer-resolved file
      // passes the basename check but fails the session-event gate.
      expect(archived).toHaveLength(3);
      expect(fs.existsSync(fakeRuntime)).toBe(true);
      expect(fs.existsSync(trajectoryFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("archives a pointer-resolved runtime file that passes ownership checks", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-trajectory-valid-"));
    try {
      const sessionId = "99999999-9999-4999-8999-999999999999";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const trajectoryFile = path.join(tmpDir, `${sessionId}.trajectory.jsonl`);
      const pointerFile = path.join(tmpDir, `${sessionId}.trajectory-path.json`);
      const altDir = path.join(tmpDir, "alt");
      fs.mkdirSync(altDir, { recursive: true });
      const altRuntime = path.join(altDir, `${sessionId}.jsonl`);
      writeSessionMeta(sessionFile, "main");
      writeTrajectoryRuntime(trajectoryFile, sessionId);
      writeTrajectoryRuntime(altRuntime, sessionId);
      writeTrajectoryPointer(pointerFile, sessionId, altRuntime);

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
      });

      // Transcript + default runtime + pointer-resolved runtime + pointer = 4
      expect(archived).toHaveLength(4);
      expect(fs.existsSync(altRuntime)).toBe(false);
      expect(fs.existsSync(trajectoryFile)).toBe(false);
      expect(fs.existsSync(pointerFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
