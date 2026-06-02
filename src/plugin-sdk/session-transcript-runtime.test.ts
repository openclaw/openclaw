import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendTranscriptEvent, upsertSessionEntry } from "../config/sessions/session-accessor.js";
import { loadSessionStore } from "../config/sessions/store.js";
import {
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  readSessionTranscriptEvents,
  resolveSessionTranscriptIdentity,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
} from "./session-transcript-runtime.js";

describe("session transcript runtime SDK", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-transcript-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("resolves transcript identity and reads events without returning sessionFile", async () => {
    const scope = {
      agentId: "Main",
      sessionId: "session-with-colon",
      sessionKey: "agent:main:main",
      storePath,
    };
    const event = { id: "event-1", type: "message" };

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
