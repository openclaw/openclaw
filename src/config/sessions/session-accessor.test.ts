import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  applyRestartRecoveryLifecycle,
  appendTranscriptMessage,
  applySessionEntryLifecycleMutation,
  commitReplySessionInitialization,
  createSessionEntryWithTranscript,
  listSessionEntries,
  loadReplySessionInitializationSnapshot,
  loadSessionEntry,
  loadTranscriptEvents,
  markSessionAbortTarget,
  patchSessionEntry,
  patchSessionEntryTarget,
  persistSessionResetLifecycle,
  persistSessionRolloverLifecycle,
  persistSessionTranscriptTurn,
  readSessionUpdatedAt,
  replaceSessionEntry,
  resolveSessionEntryAccessTarget,
  resolveSessionEntryCandidateTarget,
  resolveSessionTranscriptReadTarget,
  resolveSessionTranscriptRuntimeReadTarget,
  resolveSessionTranscriptRuntimeTarget,
  trimSessionTranscriptForManualCompact,
  updateSessionEntry,
  upsertSessionEntry,
} from "./session-accessor.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";
import type { SessionEntry } from "./types.js";

const cleanupArchivedSessionTranscriptsMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../gateway/session-archive.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/session-archive.runtime.js")>();
  return {
    ...actual,
    cleanupArchivedSessionTranscripts: cleanupArchivedSessionTranscriptsMock,
  };
});

describe("session accessor seam", () => {
  let tempDir: string;
  let storePath: string;
  let transcriptPath: string;

  beforeEach(() => {
    cleanupArchivedSessionTranscriptsMock.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-accessor-"));
    storePath = path.join(tempDir, "sessions.json");
    transcriptPath = path.join(tempDir, "session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads, lists, and patches session entries without exposing the file store shape", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 10,
    });

    expect(loadSessionEntry(scope)).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
    expect(readSessionUpdatedAt(scope)).toEqual(expect.any(Number));
    expect(listSessionEntries({ storePath })).toEqual([
      {
        sessionKey: "agent:main:main",
        entry: expect.objectContaining({
          model: "gpt-5.5",
          sessionId: "session-1",
          updatedAt: expect.any(Number),
        }),
      },
    ]);

    await upsertSessionEntry(scope, { model: "sonnet-4.6", updatedAt: 20 });

    expect(loadSessionEntry(scope)).toMatchObject({
      model: "sonnet-4.6",
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
  });

  it("keeps case-distinct Matrix sessions separate under nested agent ownership", async () => {
    const mixedKey = "agent:voice:agent:other:matrix:channel:!RoomAbC:example.org";
    const lowerKey = "agent:voice:agent:other:matrix:channel:!Roomabc:example.org";

    await upsertSessionEntry(
      { sessionKey: mixedKey, storePath },
      { sessionId: "mixed-session", updatedAt: 10 },
    );
    await upsertSessionEntry(
      { sessionKey: lowerKey, storePath },
      { sessionId: "lower-session", updatedAt: 20 },
    );

    expect(loadSessionEntry({ sessionKey: mixedKey, storePath })?.sessionId).toBe("mixed-session");
    expect(loadSessionEntry({ sessionKey: lowerKey, storePath })?.sessionId).toBe("lower-session");
    expect(
      listSessionEntries({ agentId: "voice", storePath }).map((entry) => entry.sessionKey),
    ).toEqual([mixedKey, lowerKey]);
  });

  it("patches the freshest target alias and rewrites it to the canonical key", async () => {
    await replaceSessionEntry(
      {
        sessionKey: "agent:main:work",
        storePath,
      },
      {
        sessionId: "canonical-session",
        updatedAt: 10,
      },
    );
    await replaceSessionEntry(
      {
        sessionKey: "agent:main:main",
        storePath,
      },
      {
        sessionId: "legacy-session",
        updatedAt: 20,
      },
    );

    const patched = await patchSessionEntryTarget(
      {
        storePath,
        target: {
          canonicalKey: "agent:main:work",
          storeKeys: ["agent:main:work", "agent:main:main"],
        },
      },
      (entry, context) => {
        expect(entry.sessionId).toBe("legacy-session");
        expect(context.existingEntry?.sessionId).toBe("legacy-session");
        return {
          label: "patched",
        };
      },
    );

    expect(patched).toMatchObject({
      label: "patched",
      sessionId: "legacy-session",
    });
    expect(listSessionEntries({ storePath })).toEqual([
      {
        sessionKey: "agent:main:work",
        entry: expect.objectContaining({
          label: "patched",
          sessionId: "legacy-session",
        }),
      },
    ]);
  });

  it("does not persist abort target changes when the entry is absent", async () => {
    const result = await markSessionAbortTarget({
      scope: {
        sessionKey: "agent:main:missing",
        storePath,
      },
      resolveAbortCutoff: () => ({ messageSid: "unused" }),
    });

    expect(result).toBeNull();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("returns an implicit candidate fallback without persisting it", () => {
    const resolved = resolveSessionEntryCandidateTarget({
      agentId: "main",
      candidateKeys: ["agent:main:missing"],
      cfg: { session: { store: storePath } },
      fallback: {
        sessionKey: "agent:main:current",
        entry: {
          sessionId: "",
          updatedAt: 40,
        },
      },
    });

    expect(resolved).toEqual({
      agentId: "main",
      candidateKey: "agent:main:current",
      entry: {
        sessionId: "",
        updatedAt: 40,
      },
      persisted: false,
      sessionKey: "agent:main:current",
    });
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("resolves non-main candidate entries from custom agent store templates", async () => {
    const storeTemplate = path.join(tempDir, "{agentId}.json");
    const supportStorePath = path.join(tempDir, "support.json");
    await upsertSessionEntry(
      {
        agentId: "support",
        sessionKey: "agent:support:main",
        storePath: supportStorePath,
      },
      {
        sessionId: "support-session",
        updatedAt: 30,
      },
    );

    const resolved = resolveSessionEntryCandidateTarget({
      agentId: "support",
      candidateKeys: ["agent:support:main"],
      cfg: { session: { store: storeTemplate } },
    });

    expect(resolved).toMatchObject({
      agentId: "support",
      candidateKey: "agent:support:main",
      entry: { sessionId: "support-session" },
      persisted: true,
      sessionKey: "agent:support:main",
    });
  });

  it("resolves non-main logical entries from custom agent store templates", async () => {
    const storeTemplate = path.join(tempDir, "{agentId}.json");
    const supportStorePath = path.join(tempDir, "support.json");
    await upsertSessionEntry(
      {
        agentId: "support",
        sessionKey: "agent:support:main",
        storePath: supportStorePath,
      },
      {
        sessionId: "support-session",
        updatedAt: 30,
      },
    );

    const resolved = resolveSessionEntryAccessTarget({
      cfg: { session: { store: storeTemplate } },
      sessionKey: "agent:support:main",
    });

    expect(resolved).toMatchObject({
      agentId: "support",
      canonicalKey: "agent:support:main",
      entry: { sessionId: "support-session" },
      requestedKey: "agent:support:main",
      storeKey: "agent:support:main",
    });
  });

  it("creates durable session ids for metadata-only inserts", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    const inserted = await upsertSessionEntry(scope, { model: "gpt-5.5" });

    expect(inserted?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(inserted?.sessionId).not.toBe(scope.sessionKey);
    expect(loadSessionEntry(scope)?.sessionId).toBe(inserted?.sessionId);
  });

  it("creates entries with initialized SQLite transcripts and scoped session metadata", async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    };

    const created = await createSessionEntryWithTranscript(scope, ({ sessionEntries }) => {
      expect(sessionEntries).toEqual({});
      return {
        ok: true,
        entry: {
          sessionId: "session-1",
          updatedAt: 10,
        },
      };
    });

    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("expected session creation to succeed");
    }
    expect(created.sessionFile).toContain("sqlite:main:session-1:");
    expect(created.entry.sessionFile).toBe(created.sessionFile);
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "session-1", type: "session" })]);
  });

  it("persists store-backed turns to SQLite when an old sessionFile path is present", async () => {
    const legacyTranscript = path.join(tempDir, "legacy-topic.jsonl");
    const scope = {
      agentId: "main",
      sessionId: "legacy-topic-session",
      sessionKey: "agent:main:telegram:group:1:topic:2",
      storePath,
      sessionFile: legacyTranscript,
    };
    await upsertSessionEntry(
      { sessionKey: scope.sessionKey, storePath },
      {
        sessionId: scope.sessionId,
        sessionFile: legacyTranscript,
        updatedAt: 10,
      },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "user", content: "store-backed sqlite turn" } }],
      touchSessionEntry: true,
      updateMode: "none",
    });

    expect(result.sessionFile).toContain("sqlite:main:legacy-topic-session:");
    const entry = loadSessionEntry({ sessionKey: scope.sessionKey, storePath });
    expect(entry?.sessionFile).toBe(result.sessionFile);
    await expect(loadTranscriptEvents(scope)).resolves.toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "user",
          content: "store-backed sqlite turn",
        }),
      }),
    );
    expect(fs.existsSync(legacyTranscript)).toBe(false);
  });

  it("guards store-backed turns in SQLite when an old sessionFile path is present", async () => {
    const legacyTranscript = path.join(tempDir, "guarded-legacy-topic.jsonl");
    const scope = {
      agentId: "main",
      sessionId: "guarded-topic-session",
      sessionKey: "agent:main:telegram:group:1:topic:3",
      storePath,
      sessionFile: legacyTranscript,
    };
    await upsertSessionEntry(
      { sessionKey: scope.sessionKey, storePath },
      {
        sessionId: scope.sessionId,
        sessionFile: legacyTranscript,
        updatedAt: 10,
      },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      expectedSessionId: scope.sessionId,
      messages: [{ message: { role: "assistant", content: "guarded sqlite turn" } }],
      touchSessionEntry: true,
      updateMode: "none",
    });

    expect(result.rejectedReason).toBeUndefined();
    expect(result.sessionFile).toContain("sqlite:main:guarded-topic-session:");
    const entry = loadSessionEntry({ sessionKey: scope.sessionKey, storePath });
    expect(entry?.sessionFile).toBe(result.sessionFile);
    await expect(loadTranscriptEvents(scope)).resolves.toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "assistant",
          content: "guarded sqlite turn",
        }),
      }),
    );
    expect(fs.existsSync(legacyTranscript)).toBe(false);
  });

  it("appends SQLite turns to the active transcript leaf", async () => {
    const scope = {
      agentId: "main",
      sessionId: "branched-topic-session",
      sessionKey: "agent:main:telegram:group:1:topic:4",
      storePath,
    };
    await replaceSqliteTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "root",
        parentId: null,
        message: { role: "user", content: "root prompt" },
      },
      {
        type: "message",
        id: "abandoned",
        parentId: "root",
        message: { role: "assistant", content: "abandoned answer" },
      },
      {
        type: "leaf",
        id: "select-root",
        parentId: "abandoned",
        targetId: "root",
        appendParentId: "root",
      },
    ]);

    await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "assistant", content: "active answer" } }],
      updateMode: "none",
    });

    const appended = (await loadTranscriptEvents(scope)).at(-1);
    expect(appended).toMatchObject({
      type: "message",
      parentId: "root",
      message: { role: "assistant", content: "active answer" },
    });
  });

  it("does not persist the entry when creation validation fails", async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    };

    const created = await createSessionEntryWithTranscript(scope, () => ({
      error: "invalid patch",
      ok: false,
    }));

    expect(created).toMatchObject({
      ok: false,
      phase: "entry",
    });
    expect(loadSessionEntry(scope)).toBeUndefined();
    expect(listSessionEntries({ storePath })).toEqual([]);
  });

  it("commits reply session initialization with a guarded snapshot", async () => {
    const sessionKey = "agent:main:main";
    const previousTranscript = path.join(tempDir, "previous.jsonl");
    fs.writeFileSync(
      previousTranscript,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "previous-session",
        timestamp: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionFile: previousTranscript,
        sessionId: "previous-session",
        updatedAt: 10,
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      previousEntry: snapshot.currentEntry,
      sessionEntry: {
        sessionId: "next-session",
        updatedAt: 20,
      },
      sessionKey,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.sessionFile).toBe(`sqlite:main:next-session:${storePath}`);
    expect(committed.sessionStoreView[sessionKey]).toMatchObject({
      sessionId: "next-session",
      sessionFile: committed.sessionEntry.sessionFile,
    });
    expect(committed.previousSessionTranscript.transcriptArchived).toBe(true);
    expect(fs.existsSync(previousTranscript)).toBe(false);
  });

  it("does not reuse the previous transcript file when initialization rotates session ids", async () => {
    const sessionKey = "agent:main:main";
    const previousTranscript = path.join(tempDir, "previous-rotation.jsonl");
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionFile: previousTranscript,
        sessionId: "previous-rotation",
        updatedAt: 10,
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      previousEntry: snapshot.currentEntry,
      sessionEntry: {
        ...snapshot.currentEntry,
        sessionFile: snapshot.currentEntry?.sessionFile,
        sessionId: "next-rotation",
        updatedAt: 20,
      },
      sessionKey,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.sessionFile).toBe(`sqlite:main:next-rotation:${storePath}`);
  });

  it("rejects stale reply session initialization snapshots without writing", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "first-session",
        updatedAt: 10,
      },
    );
    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "second-session",
        updatedAt: 20,
      },
    );

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        sessionId: "stale-session",
        updatedAt: 30,
      },
      sessionKey,
      storePath,
    });

    expect(committed).toMatchObject({
      ok: false,
      reason: "stale-snapshot",
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "second-session",
    });
  });

  it("commits reply session initialization from a guarded legacy alias snapshot", async () => {
    const sessionKey = "agent:main:main";
    await applySessionEntryLifecycleMutation({
      storePath,
      upserts: [
        {
          sessionKey: "Agent:Main:Main",
          entry: {
            sessionId: "legacy-alias-session",
            updatedAt: 10,
          },
        },
      ],
    });

    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      previousEntry: snapshot.currentEntry,
      sessionEntry: {
        sessionId: "next-session",
        updatedAt: 20,
      },
      sessionKey,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.sessionId).toBe("next-session");
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("next-session");
  });

  it("rejects reply session initialization when the entry is deleted during prepare", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "first-session",
        updatedAt: 10,
      },
    );
    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      prepareSessionEntry: async ({ sessionEntry }) => {
        await applySessionEntryLifecycleMutation({
          removals: [{ sessionKey }],
          storePath,
        });
        return sessionEntry;
      },
      sessionEntry: {
        sessionId: "stale-session",
        updatedAt: 30,
      },
      sessionKey,
      storePath,
    });

    expect(committed).toMatchObject({
      ok: false,
      reason: "stale-snapshot",
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("updates existing entries without creating missing sessions", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await expect(updateSessionEntry(scope, () => ({ model: "gpt-5.5" }))).resolves.toBeNull();
    expect(listSessionEntries({ storePath })).toEqual([]);

    await upsertSessionEntry(scope, {
      sessionId: "session-1",
      updatedAt: 10,
    });
    const beforeNullUpdate = loadSessionEntry(scope);
    await expect(updateSessionEntry(scope, () => null)).resolves.toEqual(beforeNullUpdate);
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "session-1",
      updatedAt: beforeNullUpdate?.updatedAt,
    });
    await expect(
      updateSessionEntry(scope, () => ({ model: "gpt-5.5", updatedAt: 20 })),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
  });

  it("replaces entries so deleted fields stay removed", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      model: "gpt-5.5",
      providerOverride: "openai",
      sessionId: "session-1",
      updatedAt: 10,
    });

    await replaceSessionEntry(scope, {
      sessionId: "session-1",
      updatedAt: 20,
    });

    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
    expect(loadSessionEntry(scope)?.model).toBeUndefined();
    expect(loadSessionEntry(scope)?.providerOverride).toBeUndefined();
  });

  it("patches entries atomically with a fallback entry", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };
    let missingContextEntry: SessionEntry | undefined;
    let existingContextEntry: SessionEntry | undefined;

    await patchSessionEntry(
      scope,
      (entry, context) => {
        missingContextEntry = context.existingEntry;
        return {
          ...entry,
          model: "gpt-5.5",
        };
      },
      {
        fallbackEntry: {
          sessionId: "session-1",
          updatedAt: 10,
        },
        replaceEntry: true,
      },
    );

    await patchSessionEntry(
      scope,
      (entry, context) => {
        existingContextEntry = context.existingEntry;
        return {
          ...entry,
          model: undefined,
          providerOverride: "openai",
        };
      },
      { replaceEntry: true },
    );

    expect(missingContextEntry).toBeUndefined();
    expect(existingContextEntry).toMatchObject({ model: "gpt-5.5" });
    expect(loadSessionEntry(scope)).toMatchObject({
      providerOverride: "openai",
      sessionId: "session-1",
    });
    expect(loadSessionEntry(scope)?.model).toBeUndefined();
  });

  it("can patch metadata without refreshing session activity", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      sessionId: "session-1",
      updatedAt: 10,
    });
    const beforePatch = loadSessionEntry(scope);

    await patchSessionEntry(
      scope,
      () => ({
        model: "gpt-5.5",
        updatedAt: 20,
      }),
      { preserveActivity: true },
    );

    expect(loadSessionEntry(scope)).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: beforePatch?.updatedAt,
    });
  });

  it("applies restart recovery replacements without exposing mutable store rows", async () => {
    await applySessionEntryLifecycleMutation({
      storePath,
      upserts: [
        {
          sessionKey: "agent:main:main",
          entry: {
            sessionId: "session-1",
            status: "running",
            updatedAt: 10,
          },
        },
        {
          sessionKey: "agent:main:other",
          entry: {
            sessionId: "session-2",
            status: "running",
            updatedAt: 20,
          },
        },
      ],
      skipMaintenance: true,
    });

    const result = await applyRestartRecoveryLifecycle({
      storePath,
      update: (entries) => {
        const main = entries.find((entry) => entry.sessionKey === "agent:main:main");
        const other = entries.find((entry) => entry.sessionKey === "agent:main:other");
        if (other) {
          other.entry.status = "failed";
        }
        if (!main) {
          return { result: { replaced: false } };
        }
        main.entry.abortedLastRun = true;
        main.entry.updatedAt = 30;
        return {
          result: { replaced: true },
          replacements: [{ sessionKey: main.sessionKey, entry: main.entry }],
        };
      },
    });

    expect(result).toEqual({ replaced: true });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: true,
      sessionId: "session-1",
      updatedAt: 30,
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:other", storePath })).toMatchObject({
      sessionId: "session-2",
      status: "running",
      updatedAt: 20,
    });
  });

  it("captures SQLite archived transcript cleanup failures when requested", async () => {
    const cleanupError = new Error("cleanup failed");
    cleanupArchivedSessionTranscriptsMock.mockRejectedValueOnce(cleanupError);
    const scope = {
      sessionId: "session-1",
      sessionKey: "agent:main:cleanup",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptMessage(scope, {
      cwd: tempDir,
      message: { role: "user", content: "cleanup me" },
    });

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      removals: [
        {
          archiveRemovedTranscript: true,
          expectedSessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        },
      ],
      cleanupArchivedTranscripts: {
        rules: [{ action: "delete", olderThanMs: 0 }],
        nowMs: Date.now(),
      },
      captureArtifactCleanupError: true,
      skipMaintenance: true,
    });

    expect(result.removedEntries).toBe(1);
    expect(result.archivedTranscriptDirectories).toHaveLength(1);
    expect(result.artifactCleanupError).toBe(cleanupError);
    expect(cleanupArchivedSessionTranscriptsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directories: result.archivedTranscriptDirectories,
      }),
    );
  });

  it("persists reset lifecycle entry changes with transcript replay and archive", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:main";
    const previousTranscript = path.join(tempDir, "previous-session.jsonl");
    const nextTranscript = path.join(tempDir, "next-session.jsonl");
    const previousEntry: SessionEntry = {
      sessionFile: previousTranscript,
      sessionId: "previous-session",
      updatedAt: now,
    };
    const nextEntry: SessionEntry = {
      sessionFile: nextTranscript,
      sessionId: "next-session",
      updatedAt: now + 1,
    };
    fs.writeFileSync(
      previousTranscript,
      [
        JSON.stringify({ type: "session", id: "previous-session" }),
        JSON.stringify({
          id: "msg-user",
          message: { role: "user", content: "hello" },
          parentId: null,
          timestamp: "2026-06-16T00:00:00.000Z",
          type: "message",
        }),
        JSON.stringify({
          id: "msg-assistant",
          message: { role: "assistant", content: "hi" },
          parentId: "msg-user",
          timestamp: "2026-06-16T00:00:01.000Z",
          type: "message",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await upsertSessionEntry({ sessionKey, storePath }, previousEntry);

    const result = await persistSessionResetLifecycle({
      agentId: "main",
      cleanupPreviousTranscript: true,
      nextEntry,
      nextSessionFile: nextTranscript,
      previousEntry,
      previousSessionId: previousEntry.sessionId,
      sessionKey,
      storePath,
    });

    expect(result.replayedMessages).toBe(2);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject(nextEntry);
    expect(fs.existsSync(previousTranscript)).toBe(false);
    const archivedPreviousTranscripts = fs
      .readdirSync(tempDir)
      .filter((file) => file.startsWith("previous-session.jsonl.reset."));
    expect(archivedPreviousTranscripts).toHaveLength(1);
    const [archivedPreviousTranscriptName] = archivedPreviousTranscripts;
    const archivedPreviousTranscript = path.join(tempDir, archivedPreviousTranscriptName);
    expect(fs.readFileSync(archivedPreviousTranscript, "utf-8")).toContain(
      '"id":"previous-session"',
    );
    expect(fs.readFileSync(archivedPreviousTranscript, "utf-8")).toContain('"content":"hi"');
    expect(fs.readFileSync(nextTranscript, "utf-8")).toContain('"content":"hello"');
  });

  it("persists rollover entries and returns archived previous transcript info", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:telegram:dm:user";
    const retiredKey = "agent:main:main";
    const previousTranscript = path.join(tempDir, "previous-rollover.jsonl");
    const previousEntry: SessionEntry = {
      sessionFile: previousTranscript,
      sessionId: "previous-rollover",
      updatedAt: now,
    };
    const nextEntry: SessionEntry = {
      sessionFile: path.join(tempDir, "next-rollover.jsonl"),
      sessionId: "next-rollover",
      updatedAt: now + 1,
    };
    fs.writeFileSync(previousTranscript, '{"type":"session","id":"previous-rollover"}\n', "utf-8");
    await upsertSessionEntry({ sessionKey, storePath }, previousEntry);
    await upsertSessionEntry(
      { sessionKey: retiredKey, storePath },
      {
        lastChannel: "telegram",
        lastTo: "user",
        sessionId: "legacy-main",
        updatedAt: now,
      },
    );

    const result = await persistSessionRolloverLifecycle({
      activeSessionKey: sessionKey,
      agentId: "main",
      previousEntry,
      retiredEntry: {
        key: retiredKey,
        entry: {
          sessionId: "legacy-main",
          updatedAt: now,
        },
      },
      sessionEntry: nextEntry,
      sessionKey,
      storePath,
    });

    expect(result.sessionEntry).toMatchObject(nextEntry);
    expect(result.previousSessionTranscript.transcriptArchived).toBe(true);
    expect(result.previousSessionTranscript.sessionFile).toContain(
      "previous-rollover.jsonl.reset.",
    );
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject(nextEntry);
    expect(loadSessionEntry({ sessionKey: retiredKey, storePath })).toEqual({
      sessionId: "legacy-main",
      updatedAt: expect.any(Number),
    });
    expect(fs.existsSync(previousTranscript)).toBe(false);
    expect(fs.existsSync(result.previousSessionTranscript.sessionFile ?? "")).toBe(true);
  });

  it("trims a manual compact transcript and clears stale token metadata", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const manualTranscriptPath = path.join(tempDir, `${sessionId}.jsonl`);
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const contextBudgetStatus: NonNullable<SessionEntry["contextBudgetStatus"]> = {
      schemaVersion: 1,
      source: "pre-prompt-estimate",
      updatedAt: 90,
      provider: "openai",
      model: "gpt-5.5",
      route: "fits",
      shouldCompact: false,
      estimatedPromptTokens: 10,
      contextTokenBudget: 100,
      promptBudgetBeforeReserve: 80,
      reserveTokens: 20,
      effectiveReserveTokens: 20,
      remainingPromptBudgetTokens: 70,
      overflowTokens: 0,
      toolResultReducibleChars: 0,
      messageCount: 1,
      unwindowedMessageCount: 1,
    };
    await upsertSessionEntry(scope, {
      contextBudgetStatus,
      inputTokens: 10,
      outputTokens: 20,
      sessionFile: manualTranscriptPath,
      sessionId,
      totalTokens: 30,
      totalTokensFresh: true,
      updatedAt: 100,
    });
    const transcriptRecords = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-06-19T12:00:00.000Z",
        cwd: tempDir,
      },
      ...[1, 2, 3, 4].map((index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 1 ? null : `entry-${index - 1}`,
        timestamp: `2026-06-19T12:00:0${index}.000Z`,
        message: { role: "user", content: `message ${index}`, timestamp: index },
      })),
    ];
    await replaceSqliteTranscriptEvents(
      scope,
      transcriptRecords as Parameters<typeof replaceSqliteTranscriptEvents>[1],
    );
    const updates: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    const result = await trimSessionTranscriptForManualCompact(scope, {
      maxLines: 3,
      nowMs: 500,
    });

    unsubscribe();
    expect(result).toMatchObject({ compacted: true, kept: 3 });
    const archived = result.compacted ? result.archived : "";
    expect(archived).toContain(`sqlite:main:${sessionId}:`);
    const trimmedRecords = (await loadTranscriptEvents(scope)) as Array<Record<string, unknown>>;
    expect(trimmedRecords).toMatchObject([
      { type: "session", id: sessionId },
      { type: "message", id: "entry-3", parentId: null },
      { type: "message", id: "entry-4", parentId: "entry-3" },
    ]);
    const updatedEntry = loadSessionEntry(scope);
    expect(updatedEntry).toMatchObject({
      sessionFile: manualTranscriptPath,
      sessionId,
      updatedAt: 500,
    });
    expect(updatedEntry?.contextBudgetStatus).toBeUndefined();
    expect(updatedEntry?.inputTokens).toBeUndefined();
    expect(updatedEntry?.outputTokens).toBeUndefined();
    expect(updatedEntry?.totalTokens).toBeUndefined();
    expect(updatedEntry?.totalTokensFresh).toBeUndefined();
    expect(updates).toEqual([]);
  });

  it("repairs a retained compaction boundary when its first kept entry was trimmed", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const sessionFile = path.join(tempDir, `${sessionId}.jsonl`);
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const records = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-06-19T12:00:00.000Z",
        cwd: tempDir,
      },
      {
        type: "message",
        id: "old-boundary",
        parentId: null,
        timestamp: "2026-06-19T12:00:01.000Z",
        message: { role: "user", content: "old", timestamp: 1 },
      },
      {
        type: "message",
        id: "kept-before-compaction",
        parentId: "old-boundary",
        timestamp: "2026-06-19T12:00:02.000Z",
        message: { role: "user", content: "kept before", timestamp: 2 },
      },
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "kept-before-compaction",
        timestamp: "2026-06-19T12:00:03.000Z",
        summary: "summary",
        firstKeptEntryId: "old-boundary",
        tokensBefore: 100,
      },
      {
        type: "compaction",
        id: "compaction-2",
        parentId: "compaction-1",
        timestamp: "2026-06-19T12:00:04.000Z",
        summary: "hardened summary",
        firstKeptEntryId: "compaction-2",
        tokensBefore: 50,
      },
      {
        type: "message",
        id: "kept-after-compaction",
        parentId: "compaction-2",
        timestamp: "2026-06-19T12:00:05.000Z",
        message: { role: "user", content: "kept after", timestamp: 5 },
      },
    ];
    await upsertSessionEntry(scope, { sessionFile, sessionId, updatedAt: 1 });
    await replaceSqliteTranscriptEvents(
      scope,
      records as Parameters<typeof replaceSqliteTranscriptEvents>[1],
    );

    await expect(
      trimSessionTranscriptForManualCompact(scope, { maxLines: 5 }),
    ).resolves.toMatchObject({ compacted: true, kept: 5 });

    const reopened = (await loadTranscriptEvents(scope)) as Array<Record<string, unknown>>;
    expect(
      reopened.find((entry) => entry.type === "compaction" && entry.id === "compaction-1"),
    ).toMatchObject({
      firstKeptEntryId: "kept-before-compaction",
    });
    expect(
      reopened.find((entry) => entry.type === "compaction" && entry.id === "compaction-2"),
    ).toMatchObject({ firstKeptEntryId: "compaction-2" });
    const serializedContext = JSON.stringify(reopened);
    expect(serializedContext).toContain("kept before");
    expect(serializedContext).toContain("kept after");
  });

  it("persists a transcript turn, touches metadata, and publishes after the write", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-lock-order",
      sessionKey: "agent:main:lock-order",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    const updates: Array<{
      sessionFile: string | undefined;
      target: unknown;
      updatedAt: number | undefined;
    }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      updates.push({
        sessionFile: update.sessionFile,
        target: update.target,
        updatedAt: loadSessionEntry(scope)?.updatedAt,
      });
    });

    const result = await persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      messages: [
        {
          message: {
            role: "user",
            content: "hello",
            timestamp: 100,
          },
        },
        {
          message: {
            role: "assistant",
            content: "hi there",
            timestamp: 200,
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });
    unsubscribe();

    expect(result.appendedCount).toBe(2);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(3);
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionFile: result.sessionFile,
      sessionId: scope.sessionId,
      updatedAt: expect.any(Number),
    });
    expect(loadSessionEntry(scope)?.updatedAt).toBeGreaterThanOrEqual(10);
    expect(updates).toEqual([
      {
        sessionFile: result.sessionFile,
        target: {
          agentId: "main",
          sessionId: "session-lock-order",
          sessionKey: "agent:main:lock-order",
        },
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("allows concurrent SQLite transcript turn and direct appends", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    let markShouldAppendEntered!: () => void;
    const shouldAppendEntered = new Promise<void>((resolve) => {
      markShouldAppendEntered = resolve;
    });
    let resumeShouldAppend!: () => void;
    const shouldAppendReleased = new Promise<boolean>((resolve) => {
      resumeShouldAppend = () => resolve(true);
    });

    const turnPromise = persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      messages: [
        {
          message: {
            role: "assistant",
            content: "batch reply",
            timestamp: 100,
          },
          shouldAppend: async () => {
            markShouldAppendEntered();
            return await shouldAppendReleased;
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });

    await shouldAppendEntered;
    const queuedAppendPromise = appendTranscriptMessage(scope, {
      cwd: tempDir,
      message: {
        role: "user",
        content: "queued prompt",
        timestamp: 200,
      },
    });
    resumeShouldAppend();

    const results = Promise.all([turnPromise, queuedAppendPromise]);
    const completed = await Promise.race([
      results.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    expect(completed).toBe(true);
    await results;
  });

  it("persists expected-session SQLite transcript turns without reentering the writer queue", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-expected",
      sessionKey: "agent:main:expected",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });

    const turnPromise = persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      expectedSessionId: scope.sessionId,
      messages: [
        {
          message: {
            role: "assistant",
            content: "expected reply",
            timestamp: 100,
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });

    const completed = await Promise.race([
      turnPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    expect(completed).toBe(true);
    const result = await turnPromise;

    expect(result.appendedCount).toBe(1);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(2);
  });

  it("rejects expected-session transcript turns after a session rebind", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-original",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await updateSessionEntry(
      {
        sessionKey: scope.sessionKey,
        storePath,
      },
      () => ({
        sessionFile: "sqlite:main:session-replacement",
        sessionId: "session-replacement",
      }),
      { skipMaintenance: true },
    );

    const result = await persistSessionTranscriptTurn(scope, {
      expectedSessionId: scope.sessionId,
      messages: [
        {
          message: {
            role: "assistant",
            content: "late reply",
            timestamp: 100,
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });

    expect(result).toMatchObject({
      appendedCount: 0,
      rejectedReason: "session-rebound",
    });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("routes SQLite transcript turn appends through an active owned file lock", async () => {
    const scope = {
      agentId: "main",
      sessionFile: transcriptPath,
      sessionId: "session-owned-publish",
      sessionKey: "agent:main:owned-publish",
      storePath,
    };
    const publishOptions: Array<boolean | undefined> = [];
    const publishedEntryBatches: unknown[][] = [];

    await withOwnedSessionTranscriptWrites(
      {
        sessionFile: transcriptPath,
        sessionKey: scope.sessionKey,
        withSessionWriteLock: async (run, options) => {
          publishOptions.push(options?.publishOwnedWrite);
          const result = await run();
          publishedEntryBatches.push([...(options?.resolvePublishedEntries?.(result) ?? [])]);
          return result;
        },
      },
      async () =>
        await persistSessionTranscriptTurn(scope, {
          cwd: tempDir,
          messages: [
            {
              message: {
                role: "assistant",
                content: "owned batch",
                timestamp: 100,
              },
            },
          ],
          publishWhen: "always",
          touchSessionEntry: true,
          updateMode: "file-only",
        }),
    );

    expect(publishOptions).toEqual([undefined]);
    expect(publishedEntryBatches).toEqual([[]]);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(2);
  });

  it("resolves store-backed runtime transcript targets with stale file paths to markers", async () => {
    const staleSessionFile = path.join(tempDir, "session-1.jsonl");
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    const marker = `sqlite:main:${scope.sessionId}:${storePath}`;

    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      sessionFile: staleSessionFile,
      updatedAt: 10,
    });

    const readTarget = await resolveSessionTranscriptRuntimeReadTarget(scope);
    const writeTarget = await resolveSessionTranscriptRuntimeTarget(scope);

    expect(readTarget.sessionFile).toBe(marker);
    expect(writeTarget.sessionFile).toBe(marker);
    expect(loadSessionEntry(scope)?.sessionFile).toBe(staleSessionFile);
  });

  it("resolves SQLite-backed runtime transcript targets to markers", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    const marker = `sqlite:main:${scope.sessionId}:${storePath}`;

    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      sessionFile: marker,
      updatedAt: 10,
    });

    const readTarget = await resolveSessionTranscriptRuntimeReadTarget(scope);
    const writeTarget = await resolveSessionTranscriptRuntimeTarget(scope);

    expect(readTarget.sessionFile).toBe(marker);
    expect(writeTarget.sessionFile).toBe(marker);
  });

  it("resolves an explicit read transcript file without agent identity", () => {
    const explicitSessionFile = path.join(tempDir, "explicit-read-session.jsonl");

    const target = resolveSessionTranscriptReadTarget({
      sessionFile: explicitSessionFile,
      sessionId: "session-1",
    });

    expect(target).toEqual({
      sessionFile: explicitSessionFile,
      sessionId: "session-1",
    });
  });

  it("does not expose legacy custom transcript paths as read fallbacks after SQLite migration", async () => {
    const legacyTranscript = path.join(tempDir, "custom-topic-transcript.jsonl");
    const sessionKey = "agent:main:telegram:group:1:topic:9";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "custom-topic-session",
        sessionFile: legacyTranscript,
        updatedAt: 10,
      },
    );

    const target = resolveSessionTranscriptReadTarget({
      agentId: "main",
      sessionId: "custom-topic-session",
      sessionKey,
      storePath,
    });

    expect(target.sessionFile).toContain("sqlite:main:custom-topic-session:");
  });
});
