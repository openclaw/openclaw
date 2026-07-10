import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import type { SessionEntry } from "./types.js";

// A new session's transcript must be created in the configured `session.store`
// dir (a foreign root), not the default agents dir the caller derived
// `fallbackSessionFile` from. Sibling fix for the transcript-mirror path: #95782.
describe("resolveAndPersistSessionFile — honor a relocated session.store", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("roots a new session's transcript in the store dir, not the default agents dir", async () => {
    const root = tempDirs.make("sf-store-");
    const storeDir = path.join(root, "persist", "agents", "main", "sessions"); // foreign root
    const defaultDir = path.join(root, "state", "agents", "main", "sessions"); // default agents dir
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(defaultDir, { recursive: true });

    const sessionId = "sess-new-1";
    const sessionKey = "agent:main:chat:u:v";
    const sessionStore: Record<string, SessionEntry> = {};

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: path.join(storeDir, "sessions.json"),
      sessionsDir: storeDir, // authoritative = dirname(session.store)
      fallbackSessionFile: path.join(defaultDir, `${sessionId}.jsonl`),
    });

    expect(path.dirname(result.sessionFile)).toBe(storeDir);
    expect(result.sessionFile).toBe(path.join(storeDir, `${sessionId}.jsonl`));
    expect(result.sessionFile.startsWith(defaultDir)).toBe(false);
    expect(sessionStore[sessionKey]?.sessionFile).toBe(result.sessionFile);
  });

  it("preserves the topic id in the re-rooted filename", async () => {
    const root = tempDirs.make("sf-topic-");
    const storeDir = path.join(root, "persist", "agents", "main", "sessions");
    const defaultDir = path.join(root, "state", "agents", "main", "sessions");
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(defaultDir, { recursive: true });

    const sessionId = "sess-topic-1";
    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey: "agent:main:chat:u:v",
      sessionStore: {},
      storePath: path.join(storeDir, "sessions.json"),
      sessionsDir: storeDir,
      fallbackSessionFile: path.join(defaultDir, `${sessionId}-topic-42.jsonl`),
    });

    expect(result.sessionFile).toBe(path.join(storeDir, `${sessionId}-topic-42.jsonl`));
  });

  it("is a no-op when the store dir already equals the fallback dir (default layout)", async () => {
    const root = tempDirs.make("sf-default-");
    const dir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(dir, { recursive: true });

    const sessionId = "sess-default-1";
    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey: "agent:main:chat:u:v",
      sessionStore: {},
      storePath: path.join(dir, "sessions.json"),
      sessionsDir: dir,
      fallbackSessionFile: path.join(dir, `${sessionId}.jsonl`),
    });

    expect(result.sessionFile).toBe(path.join(dir, `${sessionId}.jsonl`));
  });
});
