// SQLite transcript markers are storage targets, not filesystem paths.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSessionFilePath } from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore } from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("SQLite sessionFile markers", () => {
  const fixture = useTempSessionsFixture("sqlite-session-file-marker-");

  it("keeps generic session path resolution filesystem-only", () => {
    const marker = "sqlite:main:sess-1:/tmp/openclaw/agents/main/agent/openclaw-agent.sqlite";
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath("sess-1", { sessionFile: marker }, { sessionsDir });

    expect(resolved).toBe(path.join(sessionsDir, "sess-1.jsonl"));
  });

  it("does not downgrade matching SQLite markers when resolving runtime session files", async () => {
    const sessionId = "sqlite-session-id";
    const sessionKey = "agent:main:telegram:group:123";
    const marker = `sqlite:main:${sessionId}:${fixture.storePath()}`;
    const store = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        sessionFile: marker,
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");
    const sessionStore = loadSessionStore(fixture.storePath(), { skipCache: true });

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      sessionEntry: sessionStore[sessionKey],
    });

    expect(result.sessionFile).toBe(marker);
    expect(result.sessionEntry.sessionFile).toBe(marker);

    const saved = loadSessionStore(fixture.storePath(), { skipCache: true });
    expect(saved[sessionKey]?.sessionFile).toBe(marker);
  });

  it("does not preserve persisted markers for a different session", async () => {
    const sessionId = "current-sqlite-session-id";
    const sessionKey = "agent:main:telegram:group:456";
    const staleMarker = `sqlite:main:old-sqlite-session-id:${fixture.storePath()}`;
    const store = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        sessionFile: staleMarker,
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");
    const sessionStore = loadSessionStore(fixture.storePath(), { skipCache: true });

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      sessionEntry: sessionStore[sessionKey],
    });

    const expectedSessionFile = `sqlite:main:${sessionId}:${fixture.storePath()}`;
    expect(result.sessionFile).toBe(expectedSessionFile);
    expect(result.sessionEntry.sessionFile).toBe(result.sessionFile);
  });
});
