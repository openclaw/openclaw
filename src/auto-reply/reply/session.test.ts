import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { saveSessionStore } from "../../config/sessions.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.ts";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../../infra/system-events.js";
import { applyResetModelOverride } from "./session-reset-model.js";
import { prependSystemEvents } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
import { initSessionState } from "./session.js";

// Perf: session-store locks are exercised elsewhere; most session tests don't need FS lock files.
vi.mock("../../agents/session-write-lock.js", () => ({
  acquireSessionWriteLock: async () => ({ release: async () => {} }),
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "minimax", id: "m2.1", name: "M2.1" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  ]),
}));

let suiteRoot = "";
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-suite-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
  suiteRoot = "";
  suiteCase = 0;
});

async function makeCaseDir(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir);
  return dir;
}

async function makeStorePath(prefix: string): Promise<string> {
  const root = await makeCaseDir(prefix);
  return path.join(root, "sessions.json");
}

const createStorePath = makeStorePath;

describe("initSessionState thread forking", () => {
  it("forks a new session from the parent session file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Parent prompt" },
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
      "utf-8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    await saveSessionStore(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    const threadLabel = "Slack thread #general: starter";
    const result = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
        ThreadLabel: threadLabel,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionKey).toBe(threadSessionKey);
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    expect(result.sessionEntry.sessionFile).toBeTruthy();
    expect(result.sessionEntry.displayName).toBe(threadLabel);

    const newSessionFile = result.sessionEntry.sessionFile;
    if (!newSessionFile) {
      throw new Error("Missing session file for forked thread");
    }
    const [headerLine] = (await fs.readFile(newSessionFile, "utf-8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    const parsedHeader = JSON.parse(headerLine) as {
      parentSession?: string;
    };
    const expectedParentSession = await fs.realpath(parentSessionFile);
    const actualParentSession = parsedHeader.parentSession
      ? await fs.realpath(parsedHeader.parentSession)
      : undefined;
    expect(actualParentSession).toBe(expectedParentSession);
    warn.mockRestore();
  });

  it("forks from parent when thread session key already exists but was not forked yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-existing-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Parent prompt" },
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
      "utf-8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    await saveSessionStore(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      [threadSessionKey]: {
        sessionId: "preseed-thread-session",
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const first = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(first.sessionEntry.sessionId).not.toBe("preseed-thread-session");
    expect(first.sessionEntry.forkedFromParent).toBe(true);

    const second = await initSessionState({
      ctx: {
        Body: "Thread reply 2",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(second.sessionEntry.sessionId).toBe(first.sessionEntry.sessionId);
    expect(second.sessionEntry.forkedFromParent).toBe(true);
    warn.mockRestore();
  });

  it("records topic-specific session files when MessageThreadId is present", async () => {
    const root = await makeCaseDir("openclaw-topic-session-");
    const storePath = path.join(root, "sessions.json");

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Hello topic",
        SessionKey: "agent:main:telegram:group:123:topic:456",
        MessageThreadId: 456,
      },
      cfg,
      commandAuthorized: true,
    });

    const sessionFile = result.sessionEntry.sessionFile;
    expect(sessionFile).toBeTruthy();
    expect(path.basename(sessionFile ?? "")).toBe(
      `${result.sessionEntry.sessionId}-topic-456.jsonl`,
    );
  });
});

describe("initSessionState RawBody", () => {
  it("uses RawBody for command extraction and reset triggers when Body contains wrapped context", async () => {
    const root = await makeCaseDir("openclaw-rawbody-");
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const statusResult = await initSessionState({
      ctx: {
        Body: `[Chat messages since your last reply - for context]\n[WhatsApp ...] Someone: hello\n\n[Current message - respond to this]\n[WhatsApp ...] Jake: /status\n[from: Jake McInteer (+6421807830)]`,
        RawBody: "/status",
        ChatType: "group",
        SessionKey: "agent:main:whatsapp:group:g1",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(statusResult.triggerBodyNormalized).toBe("/status");

    const resetResult = await initSessionState({
      ctx: {
        Body: `[Context]\nJake: /new\n[from: Jake]`,
        RawBody: "/new",
        ChatType: "group",
        SessionKey: "agent:main:whatsapp:group:g1",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(resetResult.isNewSession).toBe(true);
    expect(resetResult.bodyStripped).toBe("");
  });

  it("preserves argument casing while still matching reset triggers case-insensitively", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-case-");
    const storePath = path.join(root, "sessions.json");

    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    const ctx = {
      RawBody: "/NEW KeepThisCase",
      ChatType: "direct",
      SessionKey: "agent:main:whatsapp:dm:s1",
    };

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.bodyStripped).toBe("KeepThisCase");
    expect(result.triggerBodyNormalized).toBe("/NEW KeepThisCase");
  });

  it("uses the default per-agent sessions store when config store is unset", async () => {
    const root = await makeCaseDir("openclaw-session-store-default-");
    const stateDir = path.join(root, ".openclaw");
    const agentId = "worker1";
    const sessionKey = `agent:${agentId}:telegram:12345`;
    const sessionId = "sess-worker-1";
    const sessionFile = path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
    const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId,
          sessionFile,
          updatedAt: Date.now(),
        },
      });

      const cfg = {} as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "hello",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.sessionEntry.sessionId).toBe(sessionId);
      expect(result.sessionEntry.sessionFile).toBe(sessionFile);
      expect(result.storePath).toBe(storePath);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("initSessionState reset policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to daily reset at 4am local time", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-daily-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s1";
    const existingSessionId = "daily-session-id";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("treats sessions as stale before the daily reset when updated before yesterday's boundary", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 3, 0, 0));
    const root = await makeCaseDir("openclaw-reset-daily-edge-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s-edge";
    const existingSessionId = "daily-edge-session";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 17, 3, 30, 0).getTime(),
      },
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("expires sessions when idle timeout wins over daily reset", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-idle-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s2";
    const existingSessionId = "idle-session-id";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("uses per-type overrides for thread sessions", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-thread-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:slack:channel:c1:thread:123";
    const existingSessionId = "thread-session-id";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        reset: { mode: "daily", atHour: 4 },
        resetByType: { thread: { mode: "idle", idleMinutes: 180 } },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "reply", SessionKey: sessionKey, ThreadLabel: "Slack thread" },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("detects thread sessions without thread key suffix", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-thread-nosuffix-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:discord:channel:c1";
    const existingSessionId = "thread-nosuffix";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        resetByType: { thread: { mode: "idle", idleMinutes: 180 } },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "reply", SessionKey: sessionKey, ThreadLabel: "Discord thread" },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("defaults to daily resets when only resetByType is configured", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-type-default-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s4";
    const existingSessionId = "type-default-session";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        resetByType: { thread: { mode: "idle", idleMinutes: 60 } },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("keeps legacy idleMinutes behavior without reset config", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-legacy-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s3";
    const existingSessionId = "legacy-session-id";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 30, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        idleMinutes: 240,
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });
});

describe("initSessionState channel reset overrides", () => {
  it("uses channel-specific reset policy when configured", async () => {
    const root = await makeCaseDir("openclaw-channel-idle-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:discord:dm:123";
    const sessionId = "session-override";
    const updatedAt = Date.now() - (10080 - 1) * 60_000;

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt,
      },
    });

    const cfg = {
      session: {
        store: storePath,
        idleMinutes: 60,
        resetByType: { direct: { mode: "idle", idleMinutes: 10 } },
        resetByChannel: { discord: { mode: "idle", idleMinutes: 10080 } },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Hello",
        SessionKey: sessionKey,
        Provider: "discord",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionEntry.sessionId).toBe(sessionId);
  });
});

describe("initSessionState reset triggers in WhatsApp groups", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    await saveSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  function makeCfg(params: { storePath: string; allowFrom: string[] }): OpenClawConfig {
    return {
      session: { store: params.storePath, idleMinutes: 999 },
      channels: {
        whatsapp: {
          allowFrom: params.allowFrom,
          groupPolicy: "open",
        },
      },
    } as OpenClawConfig;
  }

  it("applies WhatsApp group reset authorization across sender variants", async () => {
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";
    const storePath = await createStorePath("openclaw-group-reset");
    const cases = [
      {
        name: "authorized sender",
        allowFrom: ["+41796666864"],
        body: `[Chat messages since your last reply - for context]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Someone: hello\\n\\n[Current message - respond to this]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Peschiño: /new\\n[from: Peschiño (+41796666864)]`,
        senderName: "Peschiño",
        senderE164: "+41796666864",
        senderId: "41796666864:0@s.whatsapp.net",
        expectedIsNewSession: true,
      },
      {
        name: "LID sender with unauthorized E164",
        allowFrom: ["+41796666864"],
        body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Other: /new\n[from: Other (+1555123456)]`,
        senderName: "Other",
        senderE164: "+1555123456",
        senderId: "123@lid",
        expectedIsNewSession: false,
      },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStore({
        storePath,
        sessionKey,
        sessionId: existingSessionId,
      });
      const cfg = makeCfg({
        storePath,
        allowFrom: [...testCase.allowFrom],
      });

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: "/new",
          CommandBody: "/new",
          From: "120363406150318674@g.us",
          To: "+41779241027",
          ChatType: "group",
          SessionKey: sessionKey,
          Provider: "whatsapp",
          Surface: "whatsapp",
          SenderName: testCase.senderName,
          SenderE164: testCase.senderE164,
          SenderId: testCase.senderId,
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.triggerBodyNormalized, testCase.name).toBe("/new");
      expect(result.isNewSession, testCase.name).toBe(testCase.expectedIsNewSession);
      if (testCase.expectedIsNewSession) {
        expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
        expect(result.bodyStripped, testCase.name).toBe("");
      } else {
        expect(result.sessionId, testCase.name).toBe(existingSessionId);
      }
    }
  });
});

describe("initSessionState reset triggers in Slack channels", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    await saveSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  it("supports mention-prefixed Slack reset commands and preserves args", async () => {
    const existingSessionId = "existing-session-123";
    const sessionKey = "agent:main:slack:channel:c2";
    const body = "<@U123> /new take notes";
    const storePath = await createStorePath("openclaw-slack-channel-new-");
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });
    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: body,
        RawBody: body,
        CommandBody: body,
        From: "slack:channel:C1",
        To: "channel:C1",
        ChatType: "channel",
        SessionKey: sessionKey,
        Provider: "slack",
        Surface: "slack",
        SenderId: "U123",
        SenderName: "Owner",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("take notes");
  });
});

describe("applyResetModelOverride", () => {
  it("selects a model hint and strips it from the body", async () => {
    const cfg = {} as OpenClawConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: true,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.providerOverride).toBe("minimax");
    expect(sessionEntry.modelOverride).toBe("m2.1");
    expect(sessionCtx.BodyStripped).toBe("summarize");
  });

  it("clears auth profile overrides when reset applies a model", async () => {
    const cfg = {} as OpenClawConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      authProfileOverride: "anthropic:default",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: true,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("skips when resetTriggered is false", async () => {
    const cfg = {} as OpenClawConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: false,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionCtx.BodyStripped).toBe("minimax summarize");
  });
});

describe("initSessionState preserves behavior overrides across /new and /reset", () => {
  async function seedSessionStoreWithOverrides(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
    overrides: Record<string, unknown>;
  }): Promise<void> {
    await saveSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        ...params.overrides,
      },
    });
  }

  it("preserves behavior overrides across /new and /reset", async () => {
    const storePath = await createStorePath("openclaw-reset-overrides-");
    const sessionKey = "agent:main:telegram:dm:user-overrides";
    const existingSessionId = "existing-session-overrides";
    const overrides = {
      verboseLevel: "on",
      thinkingLevel: "high",
      reasoningLevel: "low",
      label: "telegram-priority",
    } as const;
    const cases = [
      {
        name: "new preserves behavior overrides",
        body: "/new",
      },
      {
        name: "reset preserves behavior overrides",
        body: "/reset",
      },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStoreWithOverrides({
        storePath,
        sessionKey,
        sessionId: existingSessionId,
        overrides: { ...overrides },
      });

      const cfg = {
        session: { store: storePath, idleMinutes: 999 },
      } as OpenClawConfig;

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: testCase.body,
          CommandBody: testCase.body,
          From: "user-overrides",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession, testCase.name).toBe(true);
      expect(result.resetTriggered, testCase.name).toBe(true);
      expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
      expect(result.sessionEntry, testCase.name).toMatchObject(overrides);
    }
  });

  it("archives the old session store entry on /new", async () => {
    const storePath = await createStorePath("openclaw-archive-old-");
    const sessionKey = "agent:main:telegram:dm:user-archive";
    const existingSessionId = "existing-session-archive";
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: { verboseLevel: "on" },
    });
    const sessionUtils = await import("../../gateway/session-utils.fs.js");
    const archiveSpy = vi.spyOn(sessionUtils, "archiveSessionTranscripts");

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user-archive",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(archiveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: existingSessionId,
        storePath,
        reason: "reset",
      }),
    );
    archiveSpy.mockRestore();
  });

  it("idle-based new session does NOT preserve overrides (no entry to read)", async () => {
    const storePath = await createStorePath("openclaw-idle-no-preserve-");
    const sessionKey = "agent:main:telegram:dm:new-user";

    const cfg = {
      session: { store: storePath, idleMinutes: 0 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        From: "new-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionEntry.verboseLevel).toBeUndefined();
    expect(result.sessionEntry.thinkingLevel).toBeUndefined();
  });
});

describe("prependSystemEvents", () => {
  it("adds a local timestamp to queued system events by default", async () => {
    vi.useFakeTimers();
    try {
      const timestamp = new Date("2026-01-12T20:19:17Z");
      const expectedTimestamp = formatZonedTimestamp(timestamp, { displaySeconds: true });
      vi.setSystemTime(timestamp);

      enqueueSystemEvent("Model switched.", { sessionKey: "agent:main:main" });

      const result = await prependSystemEvents({
        cfg: {} as OpenClawConfig,
        sessionKey: "agent:main:main",
        isMainSession: false,
        isNewSession: false,
        prefixedBodyBase: "User: hi",
      });

      expect(expectedTimestamp).toBeDefined();
      expect(result).toContain(`System: [${expectedTimestamp}] Model switched.`);
    } finally {
      resetSystemEventsForTest();
      vi.useRealTimers();
    }
  });
});

describe("persistSessionUsageUpdate", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    entry: Record<string, unknown>;
  }) {
    await fs.mkdir(path.dirname(params.storePath), { recursive: true });
    await fs.writeFile(
      params.storePath,
      JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
      "utf-8",
    );
  }

  it("uses lastCallUsage for totalTokens when provided", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now(), totalTokens: 100_000 },
    });

    const accumulatedUsage = { input: 180_000, output: 10_000, total: 190_000 };
    const lastCallUsage = { input: 12_000, output: 2_000, total: 14_000 };

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: accumulatedUsage,
      lastCallUsage,
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(12_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
    expect(stored[sessionKey].inputTokens).toBe(180_000);
    expect(stored[sessionKey].outputTokens).toBe(10_000);
  });

  it("marks totalTokens as unknown when no fresh context snapshot is available", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now() },
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 50_000, output: 5_000, total: 55_000 },
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBeUndefined();
    expect(stored[sessionKey].totalTokensFresh).toBe(false);
  });

  it("uses promptTokens when available without lastCallUsage", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now() },
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 50_000, output: 5_000, total: 55_000 },
      promptTokens: 42_000,
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(42_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("persists totalTokens from promptTokens when usage is unavailable", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      entry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        inputTokens: 1_234,
        outputTokens: 456,
      },
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: undefined,
      promptTokens: 39_000,
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(39_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
    expect(stored[sessionKey].inputTokens).toBe(1_234);
    expect(stored[sessionKey].outputTokens).toBe(456);
  });

  it("keeps non-clamped lastCallUsage totalTokens when exceeding context window", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now() },
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 300_000, output: 10_000, total: 310_000 },
      lastCallUsage: { input: 250_000, output: 5_000, total: 255_000 },
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(250_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });
});

describe("initSessionState stale threadId fallback", () => {
  it("does not inherit lastThreadId from a previous thread interaction in non-thread sessions", async () => {
    const storePath = await createStorePath("stale-thread-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    // First interaction: inside a DM topic (thread session)
    const threadResult = await initSessionState({
      ctx: {
        Body: "hello from topic",
        SessionKey: "agent:main:main:thread:42",
        MessageThreadId: 42,
      },
      cfg,
      commandAuthorized: true,
    });
    expect(threadResult.sessionEntry.lastThreadId).toBe(42);

    // Second interaction: plain DM (non-thread session), same store
    // The main session should NOT inherit threadId=42
    const mainResult = await initSessionState({
      ctx: {
        Body: "hello from DM",
        SessionKey: "agent:main:main",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(mainResult.sessionEntry.lastThreadId).toBeUndefined();
    expect(mainResult.sessionEntry.deliveryContext?.threadId).toBeUndefined();
  });

  it("preserves lastThreadId within the same thread session", async () => {
    const storePath = await createStorePath("preserve-thread-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    // First message in thread
    await initSessionState({
      ctx: {
        Body: "first",
        SessionKey: "agent:main:main:thread:99",
        MessageThreadId: 99,
      },
      cfg,
      commandAuthorized: true,
    });

    // Second message in same thread (MessageThreadId still present)
    const result = await initSessionState({
      ctx: {
        Body: "second",
        SessionKey: "agent:main:main:thread:99",
        MessageThreadId: 99,
      },
      cfg,
      commandAuthorized: true,
    });
    expect(result.sessionEntry.lastThreadId).toBe(99);
  });
});

describe("initSessionState internal channel routing preservation", () => {
  it("keeps persisted external lastChannel when OriginatingChannel is internal webchat", async () => {
    const storePath = await createStorePath("preserve-external-channel-");
    const sessionKey = "agent:main:telegram:group:12345";
    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "group:12345",
        deliveryContext: {
          channel: "telegram",
          to: "group:12345",
        },
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "internal follow-up",
        SessionKey: sessionKey,
        OriginatingChannel: "webchat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("telegram");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("telegram");
  });

  it("uses session key channel hint when first turn is internal webchat", async () => {
    const storePath = await createStorePath("session-key-channel-hint-");
    const sessionKey = "agent:main:telegram:group:98765";
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: sessionKey,
        OriginatingChannel: "webchat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("telegram");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("telegram");
  });

  it("keeps webchat channel for webchat/main sessions", async () => {
    const storePath = await createStorePath("preserve-webchat-main-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: "agent:main:main",
        OriginatingChannel: "webchat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("webchat");
  });
});
