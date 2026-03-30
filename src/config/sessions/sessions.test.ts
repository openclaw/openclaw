import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import * as jsonFiles from "../../infra/json-files.js";
import * as transcriptEvents from "../../sessions/transcript-events.js";
import type { OpenClawConfig } from "../config.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  mergeSessionEntry,
  resolveAndPersistSessionFile,
  updateSessionStore,
} from "../sessions.js";
import type { SessionConfig } from "../types.base.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPathInDir,
  validateSessionId,
} from "./paths.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset.js";
import { appendAssistantMessageToSessionTranscript } from "./transcript.js";
import type { SessionEntry } from "./types.js";

function useTempSessionsFixture(prefix: string) {
  let tempDir = "";
  let storePath = "";
  let sessionsDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    storePath = path.join(sessionsDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    storePath: () => storePath,
    sessionsDir: () => sessionsDir,
  };
}

describe("session path safety", () => {
  it("rejects unsafe session IDs", () => {
    const unsafeSessionIds = ["../etc/passwd", "a/b", "a\\b", "/abs"];
    for (const sessionId of unsafeSessionIds) {
      expect(() => validateSessionId(sessionId), sessionId).toThrow(/Invalid session ID/);
    }
  });

  it("resolves transcript path inside an explicit sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";
    const resolved = resolveSessionTranscriptPathInDir("sess-1", sessionsDir, "topic/a+b");

    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1-topic-topic%2Fa%2Bb.jsonl"));
  });

  it("falls back to derived path when sessionFile is outside known agent sessions dirs", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "/tmp/openclaw/agents/work/not-sessions/abc-123.jsonl" },
      { sessionsDir },
    );
    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1.jsonl"));
  });

  it("ignores multi-store sentinel paths when deriving session file options", () => {
    expect(resolveSessionFilePathOptions({ agentId: "worker", storePath: "(multiple)" })).toEqual({
      agentId: "worker",
    });
    expect(resolveSessionFilePathOptions({ storePath: "(multiple)" })).toBeUndefined();
  });

  it("accepts symlink-alias session paths that resolve under the sessions dir", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-session-"));
    const realRoot = path.join(tmpDir, "real-state");
    const aliasRoot = path.join(tmpDir, "alias-state");
    try {
      const sessionsDir = path.join(realRoot, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.symlinkSync(realRoot, aliasRoot, "dir");
      const viaAlias = path.join(aliasRoot, "agents", "main", "sessions", "sess-1.jsonl");
      fs.writeFileSync(path.join(sessionsDir, "sess-1.jsonl"), "");
      const resolved = resolveSessionFilePath("sess-1", { sessionFile: viaAlias }, { sessionsDir });
      expect(fs.realpathSync(resolved)).toBe(
        fs.realpathSync(path.join(sessionsDir, "sess-1.jsonl")),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves logical session paths when the sessions dir is a symlink", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-logical-session-"));
    const realRoot = path.join(tmpDir, "real-state");
    const aliasRoot = path.join(tmpDir, "alias-state");
    try {
      fs.mkdirSync(realRoot, { recursive: true });
      fs.symlinkSync(realRoot, aliasRoot, "dir");
      const logicalSessionsDir = path.join(aliasRoot, "agents", "main", "sessions");
      fs.mkdirSync(logicalSessionsDir, { recursive: true });
      const logicalTranscript = path.join(logicalSessionsDir, "sess-1.jsonl");
      fs.writeFileSync(logicalTranscript, "");

      const resolved = resolveSessionFilePath(
        "sess-1",
        { sessionFile: logicalTranscript },
        { sessionsDir: logicalSessionsDir },
      );

      expect(resolved).toBe(logicalTranscript);
      expect(fs.realpathSync(resolved)).toBe(
        fs.realpathSync(path.join(realRoot, "agents", "main", "sessions", "sess-1.jsonl")),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maps stored real session paths back to the logical symlinked sessions dir", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-real-session-"));
    const realRoot = path.join(tmpDir, "real-state");
    const aliasRoot = path.join(tmpDir, "alias-state");
    try {
      fs.mkdirSync(realRoot, { recursive: true });
      fs.symlinkSync(realRoot, aliasRoot, "dir");
      const logicalSessionsDir = path.join(aliasRoot, "agents", "main", "sessions");
      fs.mkdirSync(logicalSessionsDir, { recursive: true });
      const logicalTranscript = path.join(logicalSessionsDir, "sess-1.jsonl");
      fs.writeFileSync(logicalTranscript, "");
      const storedRealTranscript = fs.realpathSync(logicalTranscript);

      const resolved = resolveSessionFilePath(
        "sess-1",
        { sessionFile: storedRealTranscript },
        { sessionsDir: logicalSessionsDir },
      );

      expect(resolved).toBe(logicalTranscript);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maps sibling fallback paths back to the logical symlinked sessions dir", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-sibling-session-"));
    const realRoot = path.join(tmpDir, "real-state");
    const aliasRoot = path.join(tmpDir, "alias-state");
    try {
      fs.mkdirSync(realRoot, { recursive: true });
      fs.symlinkSync(realRoot, aliasRoot, "dir");
      const logicalMainSessionsDir = path.join(aliasRoot, "agents", "main", "sessions");
      const logicalWorkerSessionsDir = path.join(aliasRoot, "agents", "worker", "sessions");
      fs.mkdirSync(logicalMainSessionsDir, { recursive: true });
      fs.mkdirSync(logicalWorkerSessionsDir, { recursive: true });
      const logicalWorkerTranscript = path.join(logicalWorkerSessionsDir, "sess-1.jsonl");
      fs.writeFileSync(logicalWorkerTranscript, "");
      const storedRealTranscript = fs.realpathSync(logicalWorkerTranscript);

      const resolved = resolveSessionFilePath(
        "sess-1",
        { sessionFile: storedRealTranscript },
        { sessionsDir: logicalMainSessionsDir, agentId: "worker" },
      );

      expect(resolved).toBe(logicalWorkerTranscript);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back when sessionFile is a symlink that escapes sessions dir", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-escape-"));
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const outsideDir = path.join(tmpDir, "outside");
    try {
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, "escaped.jsonl");
      fs.writeFileSync(outsideFile, "");
      const symlinkPath = path.join(sessionsDir, "escaped.jsonl");
      fs.symlinkSync(outsideFile, symlinkPath, "file");

      const resolved = resolveSessionFilePath(
        "sess-1",
        { sessionFile: symlinkPath },
        { sessionsDir },
      );
      expect(fs.realpathSync(path.dirname(resolved))).toBe(fs.realpathSync(sessionsDir));
      expect(path.basename(resolved)).toBe("sess-1.jsonl");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("resolveSessionResetPolicy", () => {
  describe("backward compatibility: resetByType.dm -> direct", () => {
    it("does not use dm fallback for group/thread types", () => {
      const sessionCfg = {
        resetByType: {
          dm: { mode: "idle" as const, idleMinutes: 45 },
        },
      } as unknown as SessionConfig;

      const groupPolicy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "group",
      });

      expect(groupPolicy.mode).toBe("daily");
    });
  });

  it("defaults to daily resets at 4am local time", () => {
    const policy = resolveSessionResetPolicy({
      resetType: "direct",
    });

    expect(policy).toMatchObject({
      mode: "daily",
      atHour: 4,
    });
  });

  it("treats idleMinutes=0 as never expiring by inactivity", () => {
    const freshness = evaluateSessionFreshness({
      updatedAt: 1_000,
      now: 60 * 60 * 1_000,
      policy: {
        mode: "idle",
        atHour: 4,
        idleMinutes: 0,
      },
    });

    expect(freshness).toEqual({
      fresh: true,
      dailyResetAt: undefined,
      idleExpiresAt: undefined,
    });
  });
});

describe("session store lock (Promise chain mutex)", () => {
  let lockFixtureRoot = "";
  let lockCaseId = 0;
  let lockTmpDirs: string[] = [];

  async function makeTmpStore(
    initial: Record<string, unknown> = {},
  ): Promise<{ dir: string; storePath: string }> {
    const dir = path.join(lockFixtureRoot, `case-${lockCaseId++}`);
    await fsPromises.mkdir(dir);
    lockTmpDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    if (Object.keys(initial).length > 0) {
      await fsPromises.writeFile(storePath, JSON.stringify(initial, null, 2), "utf-8");
    }
    return { dir, storePath };
  }

  beforeAll(async () => {
    lockFixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-test-"));
  });

  afterAll(async () => {
    if (lockFixtureRoot) {
      await fsPromises.rm(lockFixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    lockTmpDirs = [];
  });

  it("serializes concurrent updateSessionStore calls without data loss", async () => {
    const key = "agent:main:test";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100, counter: 0 },
    });

    const N = 4;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateSessionStore(storePath, async (store) => {
          const entry = store[key] as Record<string, unknown>;
          await Promise.resolve();
          entry.counter = (entry.counter as number) + 1;
          entry.tag = `writer-${i}`;
        }),
      ),
    );

    const store = loadSessionStore(storePath);
    expect((store[key] as Record<string, unknown>).counter).toBe(N);
  });

  it("skips session store disk writes when payload is unchanged", async () => {
    const key = "agent:main:no-op-save";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s-noop", updatedAt: Date.now() },
    });

    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic");
    await updateSessionStore(
      storePath,
      async () => {
        // Intentionally no-op mutation.
      },
      { skipMaintenance: true },
    );
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("multiple consecutive errors do not permanently poison the queue", async () => {
    const key = "agent:main:multi-err";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100 },
    });

    const errors = Array.from({ length: 3 }, (_, i) =>
      updateSessionStore(storePath, async () => {
        throw new Error(`fail-${i}`);
      }),
    );

    const success = updateSessionStore(storePath, async (store) => {
      store[key] = { ...store[key], modelOverride: "recovered" } as unknown as SessionEntry;
    });

    for (const p of errors) {
      await expect(p).rejects.toThrow();
    }
    await success;

    const store = loadSessionStore(storePath);
    expect(store[key]?.modelOverride).toBe("recovered");
  });

  it("clears stale runtime provider when model is patched without provider", () => {
    const merged = mergeSessionEntry(
      {
        sessionId: "sess-runtime",
        updatedAt: 100,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
      },
      {
        model: "gpt-5.2",
      },
    );
    expect(merged.model).toBe("gpt-5.2");
    expect(merged.modelProvider).toBeUndefined();
  });

  it("normalizes orphan modelProvider fields at store write boundary", async () => {
    const key = "agent:main:orphan-provider";
    const { storePath } = await makeTmpStore({
      [key]: {
        sessionId: "sess-orphan",
        updatedAt: 100,
        modelProvider: "anthropic",
      },
    });

    await updateSessionStore(storePath, async (store) => {
      const entry = store[key];
      entry.updatedAt = Date.now();
    });

    const store = loadSessionStore(storePath);
    expect(store[key]?.modelProvider).toBeUndefined();
    expect(store[key]?.model).toBeUndefined();
  });

  it("preserves ACP metadata when replacing a session entry wholesale", async () => {
    const key = "agent:codex:acp:binding:discord:default:feedface";
    const acp = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "codex-discord",
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 100,
    };
    const { storePath } = await makeTmpStore({
      [key]: {
        sessionId: "sess-acp",
        updatedAt: 100,
        acp,
      },
    });

    await updateSessionStore(storePath, (store) => {
      store[key] = {
        sessionId: "sess-acp",
        updatedAt: 200,
        modelProvider: "openai-codex",
        model: "gpt-5.4",
      };
    });

    const store = loadSessionStore(storePath);
    expect(store[key]?.acp).toEqual(acp);
    expect(store[key]?.modelProvider).toBe("openai-codex");
    expect(store[key]?.model).toBe("gpt-5.4");
  });

  it("allows explicit ACP metadata removal through the ACP session helper", async () => {
    const key = "agent:codex:acp:binding:discord:default:deadbeef";
    const { storePath } = await makeTmpStore({
      [key]: {
        sessionId: "sess-acp-clear",
        updatedAt: 100,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        },
      },
    });
    const cfg = {
      session: {
        store: storePath,
      },
    } as OpenClawConfig;

    const result = await upsertAcpSessionMeta({
      cfg,
      sessionKey: key,
      mutate: () => null,
    });

    expect(result?.acp).toBeUndefined();
    const store = loadSessionStore(storePath);
    expect(store[key]?.acp).toBeUndefined();
  });
});

describe("appendAssistantMessageToSessionTranscript", () => {
  const fixture = useTempSessionsFixture("transcript-test-");
  const sessionId = "test-session-id";
  const sessionKey = "test-session";

  function writeTranscriptStore() {
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          chatType: "direct",
          channel: "discord",
        },
      }),
      "utf-8",
    );
  }

  it("creates transcript file and appends message for valid session", async () => {
    writeTranscriptStore();

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fs.existsSync(result.sessionFile)).toBe(true);
      const sessionFileMode = fs.statSync(result.sessionFile).mode & 0o777;
      if (process.platform !== "win32") {
        expect(sessionFileMode).toBe(0o600);
      }

      const lines = fs.readFileSync(result.sessionFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);

      const header = JSON.parse(lines[0]);
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);

      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.type).toBe("message");
      expect(messageLine.message.role).toBe("assistant");
      expect(messageLine.message.content[0].type).toBe("text");
      expect(messageLine.message.content[0].text).toBe("Hello from delivery mirror!");
    }
  });

  it("emits transcript update events for delivery mirrors", async () => {
    const sessionId = "test-session-id";
    const sessionKey = "test-session";
    const store = {
      [sessionKey]: {
        sessionId,
        chatType: "direct",
        channel: "discord",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath: fixture.storePath(),
    });

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile,
        sessionKey,
        messageId: expect.any(String),
        message: expect.objectContaining({
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          content: [{ type: "text", text: "Hello from delivery mirror!" }],
        }),
      }),
    );
    emitSpy.mockRestore();
  });

  it("does not append a duplicate delivery mirror for the same idempotency key", async () => {
    writeTranscriptStore();

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });
    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);

    const messageLine = JSON.parse(lines[1]);
    expect(messageLine.message.idempotencyKey).toBe("mirror:test-source-message");
    expect(messageLine.message.content[0].text).toBe("Hello from delivery mirror!");
  });

  it("finds session entry using normalized (lowercased) key", async () => {
    const sessionId = "test-session-normalized";
    // Store key is lowercase (as written by updateSessionStore/normalizeStoreSessionKey)
    const storeKey = "agent:main:bluebubbles:direct:+15551234567";
    const store = {
      [storeKey]: {
        sessionId,
        chatType: "direct",
        channel: "bluebubbles",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");

    // Pass a mixed-case key — append should still find the entry via normalization
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:BlueBubbles:direct:+15551234567",
      text: "Hello normalized!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
  });

  it("finds Slack session entry using normalized (lowercased) key", async () => {
    const sessionId = "test-slack-session";
    // Slack session keys include channel type and target ID; store key is lowercase
    const storeKey = "agent:main:slack:direct:u12345abc";
    const store = {
      [storeKey]: {
        sessionId,
        chatType: "direct",
        channel: "slack",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");

    // Pass a mixed-case key (as resolveSlackSession might produce) — normalization should match
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:slack:direct:U12345ABC",
      text: "Hello Slack user!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
  });

  it("ignores malformed transcript lines when checking mirror idempotency", async () => {
    writeTranscriptStore();

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        "{not-json",
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            idempotencyKey: "mirror:test-source-message",
            content: [{ type: "text", text: "Hello from delivery mirror!" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
  });
});

describe("resolveAndPersistSessionFile", () => {
  const fixture = useTempSessionsFixture("session-file-test-");

  it("persists fallback topic transcript paths for sessions without sessionFile", async () => {
    const sessionId = "topic-session-id";
    const sessionKey = "agent:main:telegram:group:123:topic:456";
    const store = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");
    const sessionStore = loadSessionStore(fixture.storePath(), { skipCache: true });
    const fallbackSessionFile = resolveSessionTranscriptPathInDir(
      sessionId,
      fixture.sessionsDir(),
      456,
    );

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      sessionEntry: sessionStore[sessionKey],
      fallbackSessionFile,
    });

    expect(result.sessionFile).toBe(fallbackSessionFile);

    const saved = loadSessionStore(fixture.storePath(), { skipCache: true });
    expect(saved[sessionKey]?.sessionFile).toBe(fallbackSessionFile);
  });

  it("creates and persists entry when session is not yet present", async () => {
    const sessionId = "new-session-id";
    const sessionKey = "agent:main:telegram:group:123";
    fs.writeFileSync(fixture.storePath(), JSON.stringify({}), "utf-8");
    const sessionStore = loadSessionStore(fixture.storePath(), { skipCache: true });
    const fallbackSessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      fallbackSessionFile,
    });

    expect(result.sessionFile).toBe(fallbackSessionFile);
    expect(result.sessionEntry.sessionId).toBe(sessionId);
    const saved = loadSessionStore(fixture.storePath(), { skipCache: true });
    expect(saved[sessionKey]?.sessionFile).toBe(fallbackSessionFile);
  });
});
