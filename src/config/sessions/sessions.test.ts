import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionConfig } from "../types.base.js";
import type { SessionEntry } from "./types.js";
import {
  clearSessionStoreCacheForTest,
  getSessionStoreLockQueueSizeForTest,
  loadSessionStore,
  updateSessionStore,
  updateSessionStoreEntry,
} from "../sessions.js";
import { withSessionStoreLockForTest } from "../sessions.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
  resolveStorePath,
  validateSessionId,
} from "./paths.js";
import { resolveSessionResetPolicy } from "./reset.js";
import { updateSessionStore as updateSessionStoreUnsafe } from "./store.js";
import {
  appendAssistantMessageToSessionTranscript,
  resolveMirroredTranscriptText,
} from "./transcript.js";

describe("deriveSessionMetaPatch", () => {
  it("captures origin + group metadata", () => {
    const patch = deriveSessionMetaPatch({
      ctx: {
        Provider: "whatsapp",
        ChatType: "group",
        GroupSubject: "Family",
        From: "123@g.us",
      },
      sessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    expect(patch?.origin?.label).toBe("Family id:123@g.us");
    expect(patch?.origin?.provider).toBe("whatsapp");
    expect(patch?.subject).toBe("Family");
    expect(patch?.channel).toBe("whatsapp");
    expect(patch?.groupId).toBe("123@g.us");
  });
});

describe("resolveStorePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const resolved = resolveStorePath("~/.openclaw/agents/{agentId}/sessions/sessions.json", {
      agentId: "research",
    });

    expect(resolved).toBe(
      path.resolve("/srv/openclaw-home/.openclaw/agents/research/sessions/sessions.json"),
    );
  });
});

describe("session path safety", () => {
  it("validates safe session IDs", () => {
    expect(validateSessionId("sess-1")).toBe("sess-1");
    expect(validateSessionId("ABC_123.hello")).toBe("ABC_123.hello");
  });

  it("rejects unsafe session IDs", () => {
    expect(() => validateSessionId("../etc/passwd")).toThrow(/Invalid session ID/);
    expect(() => validateSessionId("a/b")).toThrow(/Invalid session ID/);
    expect(() => validateSessionId("a\\b")).toThrow(/Invalid session ID/);
    expect(() => validateSessionId("/abs")).toThrow(/Invalid session ID/);
  });

  it("resolves transcript path inside an explicit sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";
    const resolved = resolveSessionTranscriptPathInDir("sess-1", sessionsDir, "topic/a+b");

    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1-topic-topic%2Fa%2Bb.jsonl"));
  });

  it("rejects unsafe sessionFile candidates that escape the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    expect(() =>
      resolveSessionFilePath("sess-1", { sessionFile: "../../etc/passwd" }, { sessionsDir }),
    ).toThrow(/within sessions directory/);

    expect(() =>
      resolveSessionFilePath("sess-1", { sessionFile: "/etc/passwd" }, { sessionsDir }),
    ).toThrow(/within sessions directory/);
  });

  it("accepts sessionFile candidates within the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "subdir/threaded-session.jsonl" },
      { sessionsDir },
    );

    expect(resolved).toBe(path.resolve(sessionsDir, "subdir/threaded-session.jsonl"));
  });

  it("accepts absolute sessionFile paths that resolve within the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "/tmp/openclaw/agents/main/sessions/abc-123.jsonl" },
      { sessionsDir },
    );

    expect(resolved).toBe(path.resolve(sessionsDir, "abc-123.jsonl"));
  });

  it("accepts absolute sessionFile with topic suffix within the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "/tmp/openclaw/agents/main/sessions/abc-123-topic-42.jsonl" },
      { sessionsDir },
    );

    expect(resolved).toBe(path.resolve(sessionsDir, "abc-123-topic-42.jsonl"));
  });

  it("rejects absolute sessionFile paths outside known agent sessions dirs", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    expect(() =>
      resolveSessionFilePath(
        "sess-1",
        { sessionFile: "/tmp/openclaw/agents/work/not-sessions/abc-123.jsonl" },
        { sessionsDir },
      ),
    ).toThrow(/within sessions directory/);
  });

  it("uses explicit agentId fallback for absolute sessionFile outside sessionsDir", () => {
    const mainSessionsDir = path.dirname(resolveStorePath(undefined, { agentId: "main" }));
    const opsSessionsDir = path.dirname(resolveStorePath(undefined, { agentId: "ops" }));
    const opsSessionFile = path.join(opsSessionsDir, "abc-123.jsonl");

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: opsSessionFile },
      { sessionsDir: mainSessionsDir, agentId: "ops" },
    );

    expect(resolved).toBe(path.resolve(opsSessionFile));
  });

  it("uses absolute path fallback when sessionFile includes a different agent dir", () => {
    const mainSessionsDir = path.dirname(resolveStorePath(undefined, { agentId: "main" }));
    const opsSessionsDir = path.dirname(resolveStorePath(undefined, { agentId: "ops" }));
    const opsSessionFile = path.join(opsSessionsDir, "abc-123.jsonl");

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: opsSessionFile },
      { sessionsDir: mainSessionsDir },
    );

    expect(resolved).toBe(path.resolve(opsSessionFile));
  });

  it("uses sibling fallback for custom per-agent store roots", () => {
    const mainSessionsDir = "/srv/custom/agents/main/sessions";
    const opsSessionFile = "/srv/custom/agents/ops/sessions/abc-123.jsonl";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: opsSessionFile },
      { sessionsDir: mainSessionsDir, agentId: "ops" },
    );

    expect(resolved).toBe(path.resolve(opsSessionFile));
  });

  it("uses extracted agent fallback for custom per-agent store roots", () => {
    const mainSessionsDir = "/srv/custom/agents/main/sessions";
    const opsSessionFile = "/srv/custom/agents/ops/sessions/abc-123.jsonl";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: opsSessionFile },
      { sessionsDir: mainSessionsDir },
    );

    expect(resolved).toBe(path.resolve(opsSessionFile));
  });

  it("uses agent sessions dir fallback for transcript path", () => {
    const resolved = resolveSessionTranscriptPath("sess-1", "main");
    expect(resolved.endsWith(path.join("agents", "main", "sessions", "sess-1.jsonl"))).toBe(true);
  });

  it("keeps storePath and agentId when resolving session file options", () => {
    const opts = resolveSessionFilePathOptions({
      storePath: "/tmp/custom/agent-store/sessions.json",
      agentId: "ops",
    });
    expect(opts).toEqual({
      sessionsDir: path.resolve("/tmp/custom/agent-store"),
      agentId: "ops",
    });
  });

  it("keeps custom per-agent store roots when agentId is provided", () => {
    const opts = resolveSessionFilePathOptions({
      storePath: "/srv/custom/agents/ops/sessions/sessions.json",
      agentId: "ops",
    });
    expect(opts).toEqual({
      sessionsDir: path.resolve("/srv/custom/agents/ops/sessions"),
      agentId: "ops",
    });
  });

  it("falls back to agentId when storePath is absent", () => {
    const opts = resolveSessionFilePathOptions({ agentId: "ops" });
    expect(opts).toEqual({ agentId: "ops" });
  });
});

describe("resolveSessionResetPolicy", () => {
  describe("backward compatibility: resetByType.dm -> direct", () => {
    it("uses resetByType.direct when available", () => {
      const sessionCfg = {
        resetByType: {
          direct: { mode: "idle" as const, idleMinutes: 30 },
        },
      } satisfies SessionConfig;

      const policy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "direct",
      });

      expect(policy.mode).toBe("idle");
      expect(policy.idleMinutes).toBe(30);
    });

    it("falls back to resetByType.dm (legacy) when direct is missing", () => {
      const sessionCfg = {
        resetByType: {
          dm: { mode: "idle" as const, idleMinutes: 45 },
        },
      } as unknown as SessionConfig;

      const policy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "direct",
      });

      expect(policy.mode).toBe("idle");
      expect(policy.idleMinutes).toBe(45);
    });

    it("prefers resetByType.direct over resetByType.dm when both present", () => {
      const sessionCfg = {
        resetByType: {
          direct: { mode: "daily" as const },
          dm: { mode: "idle" as const, idleMinutes: 99 },
        },
      } as unknown as SessionConfig;

      const policy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "direct",
      });

      expect(policy.mode).toBe("daily");
    });

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

  it("concurrent updateSessionStoreEntry patches all merge correctly", async () => {
    const key = "agent:main:merge";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100 },
    });

    await Promise.all([
      updateSessionStoreEntry({
        storePath,
        sessionKey: key,
        update: async () => {
          await Promise.resolve();
          return { modelOverride: "model-a" };
        },
      }),
      updateSessionStoreEntry({
        storePath,
        sessionKey: key,
        update: async () => {
          await Promise.resolve();
          return { thinkingLevel: "high" as const };
        },
      }),
      updateSessionStoreEntry({
        storePath,
        sessionKey: key,
        update: async () => {
          await Promise.resolve();
          return { systemPromptOverride: "custom" };
        },
      }),
    ]);

    const store = loadSessionStore(storePath);
    const entry = store[key];
    expect(entry.modelOverride).toBe("model-a");
    expect(entry.thinkingLevel).toBe("high");
    expect(entry.systemPromptOverride).toBe("custom");
  });

  it("continues processing queued tasks after a preceding task throws", async () => {
    const key = "agent:main:err";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100 },
    });

    const errorPromise = updateSessionStore(storePath, async () => {
      throw new Error("boom");
    });

    const successPromise = updateSessionStore(storePath, async (store) => {
      store[key] = { ...store[key], modelOverride: "after-error" } as unknown as SessionEntry;
    });

    await expect(errorPromise).rejects.toThrow("boom");
    await successPromise;

    const store = loadSessionStore(storePath);
    expect(store[key]?.modelOverride).toBe("after-error");
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

  it("operations on different storePaths execute concurrently", async () => {
    const { storePath: pathA } = await makeTmpStore({
      a: { sessionId: "a", updatedAt: 100 },
    });
    const { storePath: pathB } = await makeTmpStore({
      b: { sessionId: "b", updatedAt: 100 },
    });

    const order: string[] = [];
    let started = 0;
    let releaseBoth: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const markStarted = () => {
      started += 1;
      if (started === 2) {
        releaseBoth?.();
      }
    };

    const opA = updateSessionStore(pathA, async (store) => {
      order.push("a-start");
      markStarted();
      await gate;
      store.a = { ...store.a, modelOverride: "done-a" } as unknown as SessionEntry;
      order.push("a-end");
    });

    const opB = updateSessionStore(pathB, async (store) => {
      order.push("b-start");
      markStarted();
      await gate;
      store.b = { ...store.b, modelOverride: "done-b" } as unknown as SessionEntry;
      order.push("b-end");
    });

    await Promise.all([opA, opB]);

    const aStart = order.indexOf("a-start");
    const bStart = order.indexOf("b-start");
    const aEnd = order.indexOf("a-end");
    const bEnd = order.indexOf("b-end");
    const firstEnd = Math.min(aEnd, bEnd);
    expect(aStart).toBeGreaterThanOrEqual(0);
    expect(bStart).toBeGreaterThanOrEqual(0);
    expect(aEnd).toBeGreaterThanOrEqual(0);
    expect(bEnd).toBeGreaterThanOrEqual(0);
    expect(aStart).toBeLessThan(firstEnd);
    expect(bStart).toBeLessThan(firstEnd);

    expect(loadSessionStore(pathA).a?.modelOverride).toBe("done-a");
    expect(loadSessionStore(pathB).b?.modelOverride).toBe("done-b");
  });

  it("cleans up LOCK_QUEUES entry after all tasks complete", async () => {
    const { storePath } = await makeTmpStore({
      x: { sessionId: "x", updatedAt: 100 },
    });

    await updateSessionStore(storePath, async (store) => {
      store.x = { ...store.x, modelOverride: "done" } as unknown as SessionEntry;
    });

    await Promise.resolve();

    expect(getSessionStoreLockQueueSizeForTest()).toBe(0);
  });

  it("cleans up LOCK_QUEUES entry even after errors", async () => {
    const { storePath } = await makeTmpStore({});

    await updateSessionStore(storePath, async () => {
      throw new Error("fail");
    }).catch(() => undefined);

    await Promise.resolve();

    expect(getSessionStoreLockQueueSizeForTest()).toBe(0);
  });
});

describe("withSessionStoreLock storePath guard (#14717)", () => {
  it("throws descriptive error when storePath is undefined", async () => {
    await expect(
      updateSessionStoreUnsafe(undefined as unknown as string, (store) => store),
    ).rejects.toThrow("withSessionStoreLock: storePath must be a non-empty string");
  });

  it("throws descriptive error when storePath is empty string", async () => {
    await expect(updateSessionStoreUnsafe("", (store) => store)).rejects.toThrow(
      "withSessionStoreLock: storePath must be a non-empty string",
    );
  });

  it("withSessionStoreLockForTest also throws descriptive error when storePath is undefined", async () => {
    await expect(
      withSessionStoreLockForTest(undefined as unknown as string, async () => {}),
    ).rejects.toThrow("withSessionStoreLock: storePath must be a non-empty string");
  });
});

describe("resolveMirroredTranscriptText", () => {
  it("prefers media filenames over text", () => {
    const result = resolveMirroredTranscriptText({
      text: "caption here",
      mediaUrls: ["https://example.com/files/report.pdf?sig=123"],
    });
    expect(result).toBe("report.pdf");
  });

  it("returns trimmed text when no media", () => {
    const result = resolveMirroredTranscriptText({ text: "  hello  " });
    expect(result).toBe("hello");
  });
});

describe("appendAssistantMessageToSessionTranscript", () => {
  let tempDir: string;
  let storePath: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-test-"));
    sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    storePath = path.join(sessionsDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns error for missing sessionKey", async () => {
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "",
      text: "test",
      storePath,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing sessionKey");
    }
  });

  it("returns error for empty text", async () => {
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "test-session",
      text: "   ",
      storePath,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("empty text");
    }
  });

  it("returns error for unknown sessionKey", async () => {
    fs.writeFileSync(storePath, JSON.stringify({}), "utf-8");
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "nonexistent",
      text: "test message",
      storePath,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unknown sessionKey");
    }
  });

  it("creates transcript file and appends message for valid session", async () => {
    const sessionId = "test-session-id";
    const sessionKey = "test-session";
    const store = {
      [sessionKey]: {
        sessionId,
        chatType: "direct",
        channel: "discord",
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store), "utf-8");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fs.existsSync(result.sessionFile)).toBe(true);

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
});
