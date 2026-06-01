import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  listSessionEntries,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "./session-accessor.js";

describe("session accessor file-backed seam", () => {
  let tempDir: string;
  let storePath: string;
  let transcriptPath: string;

  beforeEach(() => {
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

  it("loads and appends transcript events through a session scope", async () => {
    const scope = {
      sessionFile: transcriptPath,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    const event = {
      id: "msg-1",
      message: { role: "user", content: "hello" },
      parentId: null,
      type: "message",
    };

    await appendTranscriptEvent(scope, { type: "session", sessionId: "session-1" });
    await appendTranscriptEvent(scope, event);

    await expect(loadTranscriptEvents(scope)).resolves.toEqual([
      { type: "session", sessionId: "session-1" },
      event,
    ]);
    expect(fs.statSync(transcriptPath).mode & 0o777).toBe(0o600);
  });

  it("honors thread fallback paths when resolving transcript scope from the store", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:demo-channel:1234:thread:456",
      storePath,
    };
    const event = {
      id: "msg-1",
      message: { role: "user", content: "hello" },
      parentId: null,
      type: "message",
    };

    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(scope, event);

    const expectedTranscriptPath = path.join(tempDir, "session-1-topic-456.jsonl");
    expect(fs.existsSync(expectedTranscriptPath)).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "session-1.jsonl"))).toBe(false);
    expect(fs.realpathSync(loadSessionEntry(scope)?.sessionFile ?? "")).toBe(
      fs.realpathSync(expectedTranscriptPath),
    );
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([event]);
  });

  it("persists transcript metadata under the normalized session key", async () => {
    const canonicalScope = {
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(canonicalScope, {
      sessionId: canonicalScope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(
      {
        agentId: "main",
        sessionId: canonicalScope.sessionId,
        sessionKey: "AGENT:MAIN:MAIN",
        storePath,
      },
      { id: "msg-1", type: "message" },
    );

    expect(listSessionEntries({ storePath }).map((entry) => entry.sessionKey)).toEqual([
      canonicalScope.sessionKey,
    ]);
    expect(loadSessionEntry(canonicalScope)?.sessionFile).toBeTruthy();
  });
});
