// File-backed session lifecycle operations own entry mutation and transcript artifact transitions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
} from "../../trajectory/paths.js";
import { createTrajectoryRuntimeRecorder } from "../../trajectory/runtime.js";
import {
  canonicalizeTrajectoryPath,
  clearTrajectoryWriterLifecycleRegistryForTest,
  withTrajectoryPathLock,
} from "../../trajectory/writer-lifecycle.js";
import { deleteSessionEntryLifecycle, resetSessionEntryLifecycle } from "./session-accessor.js";
import { clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

describe("session store lifecycle mutations", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-lifecycle-mutation-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    clearTrajectoryWriterLifecycleRegistryForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the new header before notifying observers and archiving the old transcript", async () => {
    const oldTranscriptPath = path.join(tempDir, "old-session.jsonl");
    const nextTranscriptPath = path.join(tempDir, "next-session.jsonl");
    let nextTranscriptAtMutation: string | undefined;
    let oldTranscriptExistsAtMutation = false;
    const now = Date.now();
    fs.writeFileSync(oldTranscriptPath, '{"type":"session","id":"old-session"}\n', "utf-8");
    await saveSessionStore(
      storePath,
      {
        "agent:main:room": {
          sessionFile: path.join(tempDir, "stale-session.jsonl"),
          sessionId: "stale-session",
          updatedAt: now - 1,
        },
        "Agent:Main:Room": {
          sessionFile: oldTranscriptPath,
          sessionId: "old-session",
          updatedAt: now,
        },
      },
      { skipMaintenance: true },
    );

    const result = await resetSessionEntryLifecycle({
      storePath,
      target: {
        canonicalKey: "agent:main:room",
        storeKeys: ["agent:main:room", "Agent:Main:Room"],
      },
      buildNextEntry: ({ currentEntry }): SessionEntry => ({
        ...currentEntry,
        sessionFile: nextTranscriptPath,
        sessionId: "next-session",
        updatedAt: now + 1,
        systemSent: false,
        abortedLastRun: false,
      }),
      afterEntryMutation: () => {
        nextTranscriptAtMutation = fs.readFileSync(nextTranscriptPath, "utf-8");
        oldTranscriptExistsAtMutation = fs.existsSync(oldTranscriptPath);
      },
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:main:room"]?.sessionId).toBe("next-session");
    expect(store["Agent:Main:Room"]).toBeUndefined();
    expect(result.previousSessionId).toBe("old-session");
    expect(nextTranscriptAtMutation).toContain('"id":"next-session"');
    expect(oldTranscriptExistsAtMutation).toBe(true);
    expect(result.archivedTranscripts).toHaveLength(1);
    expect(result.archivedTranscripts[0]?.archivedPath).toContain(".jsonl.reset.");
    expect(fs.existsSync(oldTranscriptPath)).toBe(false);
    expect(fs.readFileSync(nextTranscriptPath, "utf-8")).toContain('"id":"next-session"');
  });

  it("preserves a successor header when a custom transcript path is reused", async () => {
    const sessionKey = "agent:main:custom";
    const transcriptPath = path.join(tempDir, "custom-transcript.jsonl");
    const oldSessionId = "11111111-1111-4111-8111-111111111111";
    const nextSessionId = "22222222-2222-4222-8222-222222222222";
    fs.writeFileSync(transcriptPath, `{"type":"session","id":"${oldSessionId}"}\n`, "utf-8");
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: {
          sessionFile: transcriptPath,
          sessionId: oldSessionId,
          updatedAt: 1,
        },
      },
      { skipMaintenance: true },
    );

    await resetSessionEntryLifecycle({
      storePath,
      target: {
        canonicalKey: sessionKey,
        storeKeys: [sessionKey],
      },
      buildNextEntry: ({ currentEntry }): SessionEntry => ({
        ...currentEntry,
        sessionFile: transcriptPath,
        sessionId: nextSessionId,
        updatedAt: 2,
      }),
    });

    const archivedTranscript = fs
      .readdirSync(tempDir)
      .find((name) => name.startsWith("custom-transcript.jsonl.deleted."));
    if (!archivedTranscript) {
      throw new Error("expected the previous custom transcript to be archived");
    }
    expect(fs.readFileSync(path.join(tempDir, archivedTranscript), "utf-8")).toContain(
      `"id":"${oldSessionId}"`,
    );
    expect(fs.readFileSync(transcriptPath, "utf-8")).toContain(`"id":"${nextSessionId}"`);
  });

  it("deletes an entry while archiving its transcript in the same lifecycle operation", async () => {
    const transcriptPath = path.join(tempDir, "delete-session.jsonl");
    const now = Date.now();
    fs.writeFileSync(transcriptPath, '{"type":"session","id":"delete-session"}\n', "utf-8");
    await saveSessionStore(
      storePath,
      {
        "agent:main:keep": {
          sessionId: "keep-session",
          sessionFile: path.join(tempDir, "keep-session.jsonl"),
          updatedAt: now,
        },
        "agent:main:delete": {
          sessionFile: transcriptPath,
          sessionId: "delete-session",
          updatedAt: now - 1,
        },
      },
      { skipMaintenance: true },
    );

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:delete",
        storeKeys: ["agent:main:delete"],
      },
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(result.deleted).toBe(true);
    expect(result.deletedSessionId).toBe("delete-session");
    expect(result.archivedTranscripts).toHaveLength(1);
    expect(result.archivedTranscripts[0]?.archivedPath).toContain(".jsonl.deleted.");
    expect(store["agent:main:delete"]).toBeUndefined();
    expect(store["agent:main:keep"]?.sessionId).toBe("keep-session");
    expect(fs.existsSync(transcriptPath)).toBe(false);
  });

  it("keeps a row that changed before guarded deletion acquired the writer lock", async () => {
    const sessionKey = "agent:main:delete";
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: {
          label: "new revision",
          sessionId: "delete-session",
          updatedAt: 2,
        },
      },
      { skipMaintenance: true },
    );

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      expectedSessionId: "delete-session",
      expectedUpdatedAt: 1,
      storePath,
      target: {
        canonicalKey: sessionKey,
        storeKeys: [sessionKey],
      },
    });

    expect(result).toMatchObject({ deleted: false, expectedEntryMismatch: true });
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toMatchObject({
      label: "new revision",
      updatedAt: 2,
    });
  });

  it("does not cache alias promotion when guarded deletion is rejected", async () => {
    const canonicalKey = "agent:main:room";
    const aliasKey = "Agent:Main:Room";
    await saveSessionStore(
      storePath,
      {
        [canonicalKey]: {
          label: "canonical",
          sessionId: "canonical-session",
          updatedAt: 1,
        },
        [aliasKey]: {
          label: "fresh alias",
          sessionId: "alias-session",
          updatedAt: 2,
        },
      },
      { skipMaintenance: true },
    );

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      expectedSessionId: "stale-session",
      storePath,
      target: {
        canonicalKey,
        storeKeys: [canonicalKey, aliasKey],
      },
    });

    expect(result).toMatchObject({ deleted: false, expectedEntryMismatch: true });
    expect(loadSessionStore(storePath)).toMatchObject({
      [canonicalKey]: { label: "canonical", sessionId: "canonical-session" },
      [aliasKey]: { label: "fresh alias", sessionId: "alias-session" },
    });
  });

  it("deletes only the exact row snapshot supplied after lifecycle cleanup", async () => {
    const sessionKey = "agent:main:delete";
    const expectedEntry = {
      label: "cleanup-owned revision",
      lifecycleRevision: "run-revision",
      sessionId: "delete-session",
      updatedAt: 2,
    } satisfies SessionEntry;
    await saveSessionStore(storePath, { [sessionKey]: expectedEntry }, { skipMaintenance: true });

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      expectedEntry,
      expectedLifecycleRevision: expectedEntry.lifecycleRevision,
      expectedSessionId: expectedEntry.sessionId,
      expectedUpdatedAt: expectedEntry.updatedAt,
      storePath,
      target: {
        canonicalKey: sessionKey,
        storeKeys: [sessionKey],
      },
    });

    expect(result.deleted).toBe(true);
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toBeUndefined();
  });

  it("removes the deleted session's trajectory artifacts alongside the transcript", async () => {
    const transcriptPath = path.join(tempDir, "delete-session.jsonl");
    const runtimePath = path.join(tempDir, "delete-session.trajectory.jsonl");
    const pointerPath = path.join(tempDir, "delete-session.trajectory-path.json");
    const now = Date.now();
    fs.writeFileSync(transcriptPath, '{"type":"session","id":"delete-session"}\n', "utf-8");
    fs.writeFileSync(runtimePath, '{"type":"session","sessionId":"delete-session"}\n', "utf-8");
    fs.writeFileSync(
      pointerPath,
      JSON.stringify({ sessionId: "delete-session", runtimeFile: runtimePath }),
      "utf-8",
    );
    await saveSessionStore(
      storePath,
      {
        "agent:main:delete": {
          sessionFile: transcriptPath,
          sessionId: "delete-session",
          updatedAt: now,
        },
      },
      { skipMaintenance: true },
    );

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:delete",
        storeKeys: ["agent:main:delete"],
      },
    });

    expect(result.deleted).toBe(true);
    expect(fs.existsSync(runtimePath)).toBe(false);
    expect(fs.existsSync(pointerPath)).toBe(false);
  });

  it("keeps trajectory artifacts while another entry still references the session", async () => {
    const transcriptPath = path.join(tempDir, "shared-session.jsonl");
    const runtimePath = path.join(tempDir, "shared-session.trajectory.jsonl");
    const pointerPath = path.join(tempDir, "shared-session.trajectory-path.json");
    const now = Date.now();
    fs.writeFileSync(transcriptPath, '{"type":"session","id":"shared-session"}\n', "utf-8");
    fs.writeFileSync(runtimePath, '{"type":"session","sessionId":"shared-session"}\n', "utf-8");
    fs.writeFileSync(
      pointerPath,
      JSON.stringify({ sessionId: "shared-session", runtimeFile: runtimePath }),
      "utf-8",
    );
    await saveSessionStore(
      storePath,
      {
        "agent:main:delete": {
          sessionFile: transcriptPath,
          sessionId: "shared-session",
          updatedAt: now - 1,
        },
        "agent:main:mirror": {
          sessionFile: transcriptPath,
          sessionId: "shared-session",
          updatedAt: now,
        },
      },
      { skipMaintenance: true },
    );

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:delete",
        storeKeys: ["agent:main:delete"],
      },
    });

    expect(result.deleted).toBe(true);
    expect(fs.existsSync(runtimePath)).toBe(true);
    expect(fs.existsSync(pointerPath)).toBe(true);
  });

  it("rejects a trajectory flush issued after the session has already been deleted", async () => {
    const sessionId = "post-delete-session";
    const transcriptPath = path.join(tempDir, "post-delete-session.jsonl");
    const now = Date.now();
    fs.writeFileSync(transcriptPath, `{"type":"session","id":"${sessionId}"}\n`, "utf-8");
    await saveSessionStore(
      storePath,
      {
        "agent:main:post-delete": {
          sessionFile: transcriptPath,
          sessionId,
          updatedAt: now,
        },
      },
      { skipMaintenance: true },
    );

    const recorder = await createTrajectoryRuntimeRecorder({
      sessionId,
      sessionFile: transcriptPath,
    });
    if (!recorder) {
      throw new Error("expected trajectory runtime recorder");
    }
    recorder.recordEvent("prompt.submitted", { marker: "should-not-land" });

    const deleteResult = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:post-delete",
        storeKeys: ["agent:main:post-delete"],
      },
    });
    expect(deleteResult.deleted).toBe(true);

    // Models the abandoned cleanup-timeout flush landing after run teardown
    // (and therefore delete) already proceeded.
    await recorder.flush();

    const runtimeFile = resolveTrajectoryFilePath({ sessionFile: transcriptPath, sessionId });
    const pointerPath = resolveTrajectoryPointerFilePath(transcriptPath);
    expect(fs.existsSync(runtimeFile)).toBe(false);
    expect(fs.existsSync(pointerPath)).toBe(false);
  });

  it("closes the race between an in-flight trajectory flush and a concurrent session delete", async () => {
    const sessionId = "race-session";
    const transcriptPath = path.join(tempDir, "race-session.jsonl");
    const now = Date.now();
    fs.writeFileSync(transcriptPath, `{"type":"session","id":"${sessionId}"}\n`, "utf-8");
    await saveSessionStore(
      storePath,
      {
        "agent:main:race": {
          sessionFile: transcriptPath,
          sessionId,
          updatedAt: now,
        },
      },
      { skipMaintenance: true },
    );

    const recorder = await createTrajectoryRuntimeRecorder({
      sessionId,
      sessionFile: transcriptPath,
    });
    if (!recorder) {
      throw new Error("expected trajectory runtime recorder");
    }
    recorder.recordEvent("prompt.submitted", { marker: "abandoned-flush" });

    const canonicalPath = canonicalizeTrajectoryPath(
      resolveTrajectoryFilePath({ sessionFile: transcriptPath, sessionId }),
    );

    // Hold the per-path lock to put flush() and delete() in the same queued
    // race an abandoned cleanup-timeout flush would create against a
    // concurrent sessions.delete — regardless of which one is admitted to
    // the lock first, the outcome must be deterministic (F1).
    let releaseHeldTurn: () => void = () => {};
    const heldTurnGate = new Promise<void>((resolve) => {
      releaseHeldTurn = resolve;
    });
    const heldTurn = withTrajectoryPathLock(canonicalPath, async () => {
      await heldTurnGate;
    });

    const flushPromise = recorder.flush();
    const deletePromise = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:race",
        storeKeys: ["agent:main:race"],
      },
    });

    releaseHeldTurn();
    await heldTurn;
    const [, deleteResult] = await Promise.all([flushPromise, deletePromise]);

    expect(deleteResult.deleted).toBe(true);
    const runtimeFile = resolveTrajectoryFilePath({ sessionFile: transcriptPath, sessionId });
    const pointerPath = resolveTrajectoryPointerFilePath(transcriptPath);
    expect(fs.existsSync(runtimeFile)).toBe(false);
    expect(fs.existsSync(pointerPath)).toBe(false);
  });

  it("does not delete a colliding sibling session's trajectory file", async () => {
    const trajectoryDir = path.join(tempDir, "traces");
    // Colliding under safeTrajectorySessionFileName's sanitizer (":" -> "_")
    // while both remain valid persisted session store ids (isSafeSessionId
    // allows ":" but not "*").
    const sessionAId = "abc:def";
    const sessionBId = "abc_def";
    const transcriptPathA = path.join(tempDir, "session-a.jsonl");
    const transcriptPathB = path.join(tempDir, "session-b.jsonl");
    const now = Date.now();
    fs.writeFileSync(transcriptPathA, `{"type":"session","id":"${sessionAId}"}\n`, "utf-8");
    fs.writeFileSync(transcriptPathB, `{"type":"session","id":"${sessionBId}"}\n`, "utf-8");
    await saveSessionStore(
      storePath,
      {
        "agent:main:a": { sessionFile: transcriptPathA, sessionId: sessionAId, updatedAt: now },
        "agent:main:b": { sessionFile: transcriptPathB, sessionId: sessionBId, updatedAt: now },
      },
      { skipMaintenance: true },
    );

    const env = { OPENCLAW_TRAJECTORY_DIR: trajectoryDir };
    const recorderA = await createTrajectoryRuntimeRecorder({
      env,
      sessionId: sessionAId,
      sessionFile: transcriptPathA,
    });
    const recorderB = await createTrajectoryRuntimeRecorder({
      env,
      sessionId: sessionBId,
      sessionFile: transcriptPathB,
    });
    if (!recorderA || !recorderB) {
      throw new Error("expected trajectory runtime recorders");
    }
    expect(recorderA.filePath).not.toBe(recorderB.filePath);
    recorderA.recordEvent("prompt.submitted", { marker: "owner-a" });
    recorderB.recordEvent("prompt.submitted", { marker: "owner-b" });
    await recorderA.flush();
    await recorderB.flush();

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: "agent:main:a", storeKeys: ["agent:main:a"] },
    });

    expect(result.deleted).toBe(true);
    expect(fs.existsSync(recorderA.filePath)).toBe(false);
    expect(fs.existsSync(recorderB.filePath)).toBe(true);
    expect(fs.readFileSync(recorderB.filePath, "utf8")).toContain("owner-b");
  });
});
