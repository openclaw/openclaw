import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendTranscriptEvent, upsertSessionEntry } from "../config/sessions/session-accessor.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import * as transcriptEvents from "../sessions/transcript-events.js";
import {
  appendSessionTranscriptMessageByIdentity,
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  publishSessionTranscriptUpdateByIdentity,
  readSessionTranscriptEvents,
  resolveSessionTranscriptIdentity,
  resolveSessionTranscriptTarget,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  withSessionTranscriptWriteLock,
} from "./session-transcript-runtime.js";

describe("session transcript runtime SDK", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-transcript-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("resolves transcript identity and reads events without returning sessionFile", async () => {
    const scope = {
      agentId: "Main",
      sessionId: "session-with-colon",
      sessionKey: "agent:main:main",
      storePath,
    };
    const event = { id: "event-1", type: "metadata" };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    await appendTranscriptEvent(scope, event);

    const identity = await resolveSessionTranscriptIdentity(scope);

    expect(identity).toEqual({
      agentId: "main",
      memoryKey: "transcript:main:session-with-colon",
      sessionId: scope.sessionId,
      sessionKey: "agent:main:main",
    });
    expect(identity).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([event]);
  });

  it("does not persist sessionFile metadata for identity-only reads", async () => {
    const scope = {
      agentId: "main",
      sessionId: "read-only-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });

    await expect(resolveSessionTranscriptIdentity(scope)).resolves.toMatchObject({
      memoryKey: "transcript:main:read-only-session",
    });
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
    expect(loadSessionStore(storePath)[scope.sessionKey]?.sessionFile).toBeUndefined();
  });

  it("skips malformed transcript lines when reading by scoped identity", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "malformed-lines.jsonl"),
      sessionId: "malformed-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const firstEvent = { id: "event-valid-1", type: "message" };
    const secondEvent = { id: "event-valid-2", type: "message" };

    fs.writeFileSync(
      scope.sessionFile,
      [
        JSON.stringify(firstEvent),
        "{malformed-json",
        JSON.stringify(secondEvent),
        "not-json",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([firstEvent, secondEvent]);
  });

  it("binds scoped reads to an explicit active transcript file without exposing it", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "active-session.jsonl"),
      sessionId: "active-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const event = { id: "event-active", type: "metadata" };

    await upsertSessionEntry(scope, {
      sessionFile: path.join(tempDir, "store-default.jsonl"),
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(scope, event);

    const target = await resolveSessionTranscriptTarget(scope);

    expect(target).toEqual({
      agentId: "main",
      memoryKey: "transcript:main:active-session",
      sessionId: "active-session",
      sessionKey: "agent:main:main",
      targetKind: "active-session-file",
    });
    expect(target).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([event]);
    expect(fs.readFileSync(scope.sessionFile, "utf8")).toContain("event-active");
  });

  it("appends messages by the same explicit scoped transcript target", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "mirror-target.jsonl"),
      sessionId: "mirror-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    };

    const appended = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message,
    });

    expect(appended).toBeDefined();
    expect(appended?.message).toMatchObject(message);
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("publishes updates with the resolved scoped transcript identity", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "publish-target.jsonl"),
      sessionId: "publish-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    await publishSessionTranscriptUpdateByIdentity({
      ...scope,
      update: {
        agentId: "stale-agent",
        messageId: "message-from-direct-publish",
        sessionKey: "agent:stale:other",
      },
    });

    expect(emitSpy).toHaveBeenCalledWith({
      agentId: "main",
      messageId: "message-from-direct-publish",
      sessionFile: scope.sessionFile,
      sessionKey: "agent:main:main",
    });
  });

  it("locks read and append helpers to one scoped transcript target", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "locked-target.jsonl"),
      sessionId: "locked-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    const target = await withSessionTranscriptWriteLock(scope, async (locked) => {
      expect(await locked.readEvents()).toEqual([]);
      await locked.appendMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "locked" }],
          timestamp: 1,
        },
      });
      return locked.target;
    });

    expect(target).toMatchObject({
      sessionId: "locked-session",
      targetKind: "active-session-file",
    });
    expect(target).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("uses the owned active transcript write context for scoped locked appends", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "owned-active-target.jsonl"),
      sessionId: "owned-active-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const storeDefaultFile = path.join(tempDir, "store-default-owned.jsonl");
    const lockEvents: string[] = [];

    await upsertSessionEntry(scope, {
      sessionFile: storeDefaultFile,
      sessionId: scope.sessionId,
      updatedAt: 10,
    });

    const target = await withOwnedSessionTranscriptWrites(
      {
        sessionFile: scope.sessionFile,
        sessionKey: scope.sessionKey,
        withSessionWriteLock: async (run) => {
          lockEvents.push("lock");
          return await run();
        },
      },
      async () =>
        await withSessionTranscriptWriteLock(scope, async (locked) => {
          await locked.appendMessage({
            message: {
              role: "assistant",
              content: [{ type: "text", text: "owned locked" }],
              timestamp: 1,
            },
          });
          return locked.target;
        }),
    );

    expect(lockEvents).toEqual(["lock"]);
    expect(target).toMatchObject({
      sessionId: "owned-active-session",
      targetKind: "active-session-file",
    });
    expect(fs.readFileSync(scope.sessionFile, "utf8")).toContain("owned locked");
    expect(fs.existsSync(storeDefaultFile)).toBe(false);
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("publishes queued locked updates after callback appends are visible", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "queued-publish-target.jsonl"),
      sessionId: "queued-publish-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const observedUpdates: Array<{
      callbackCompleted: boolean;
      fileText: string;
      update: unknown;
    }> = [];
    let callbackCompleted = false;
    const emitSpy = vi
      .spyOn(transcriptEvents, "emitSessionTranscriptUpdate")
      .mockImplementation((update) => {
        observedUpdates.push({
          callbackCompleted,
          fileText: fs.readFileSync(scope.sessionFile, "utf8"),
          update,
        });
      });

    const result = await withSessionTranscriptWriteLock(scope, async (locked) => {
      await locked.appendMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "queued publish" }],
          timestamp: 1,
        },
      });
      await locked.publishUpdate({
        messageId: "message-from-callback",
      });
      expect(emitSpy).not.toHaveBeenCalled();
      callbackCompleted = true;
      return "complete";
    });

    expect(result).toBe("complete");
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(observedUpdates).toEqual([
      {
        callbackCompleted: true,
        fileText: expect.stringContaining("queued publish"),
        update: expect.objectContaining({
          messageId: "message-from-callback",
          agentId: "main",
          sessionFile: scope.sessionFile,
          sessionKey: scope.sessionKey,
        }),
      },
    ]);
  });

  it("does not publish queued locked updates when the callback throws", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "failed-queued-publish-target.jsonl"),
      sessionId: "failed-queued-publish-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    await expect(
      withSessionTranscriptWriteLock(scope, async (locked) => {
        await locked.appendMessage({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "durable but failed" }],
            timestamp: 1,
          },
        });
        await locked.publishUpdate({ sessionKey: scope.sessionKey });
        throw new Error("stop before commit");
      }),
    ).rejects.toThrow("stop before commit");
    expect(emitSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(scope.sessionFile, "utf8")).toContain("durable but failed");
  });

  it("round-trips encoded memory hit keys with opaque session ids", () => {
    const key = formatSessionTranscriptMemoryHitKey({
      agentId: "SECONDARY",
      sessionId: "my-plugin:task/1",
    });

    expect(key).toBe("transcript:secondary:my-plugin%3Atask%2F1");
    expect(parseSessionTranscriptMemoryHitKey(key)).toEqual({
      agentId: "secondary",
      key,
      sessionId: "my-plugin:task/1",
    });
  });

  it("resolves memory hit keys by agent and session id instead of transcript basename", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-id",
      sessionKey: "agent:main:telegram:direct:123",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionFile: path.join(tempDir, "legacy-file-name.jsonl"),
      sessionId: scope.sessionId,
      updatedAt: 10,
    });

    const keys = resolveSessionTranscriptMemoryHitKeyToSessionKeys({
      key: formatSessionTranscriptMemoryHitKey(scope),
      store: loadSessionStore(storePath),
    });

    expect(keys).toEqual(["agent:main:telegram:direct:123"]);
  });

  it("can avoid synthetic fallback keys for strict live-store checks", () => {
    const key = formatSessionTranscriptMemoryHitKey({
      agentId: "main",
      sessionId: "deleted-session",
    });

    expect(resolveSessionTranscriptMemoryHitKeyToSessionKeys({ key, store: {} })).toEqual([
      "agent:main:deleted-session",
    ]);
    expect(
      resolveSessionTranscriptMemoryHitKeyToSessionKeys({
        includeSyntheticFallback: false,
        key,
        store: {},
      }),
    ).toEqual([]);
  });
});
