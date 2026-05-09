import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { upsertSessionEntry } from "../../config/sessions/store.js";
import { replaceSqliteSessionTranscriptEvents } from "../../config/sessions/transcript-store.sqlite.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { initSessionState } from "./session.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runSessionStart: vi.fn<HookRunner["runSessionStart"]>(),
  runSessionEnd: vi.fn<HookRunner["runSessionEnd"]>(),
}));
const sessionCleanupMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
  resetRegisteredAgentHarnessSessions: vi.fn(async () => undefined),
  retireSessionMcpRuntime: vi.fn(async () => false),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runSessionStart: hookRunnerMocks.runSessionStart,
      runSessionEnd: hookRunnerMocks.runSessionEnd,
    }) as unknown as HookRunner,
}));

vi.mock("../../agents/harness/registry.js", () => ({
  resetRegisteredAgentHarnessSessions: sessionCleanupMocks.resetRegisteredAgentHarnessSessions,
}));

vi.mock("../../agents/pi-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: sessionCleanupMocks.retireSessionMcpRuntime,
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: sessionCleanupMocks.closeTrackedBrowserTabsForSessions,
}));

async function createFixtureDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  return root;
}

async function writeSessionRows(
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(store)) {
    upsertSessionEntry({ agentId: "main", sessionKey, entry: entry as SessionEntry });
  }
}

async function writeTranscript(sessionId: string, text = "hello"): Promise<void> {
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId,
    events: [
      {
        type: "message",
        id: `${sessionId}-m1`,
        message: { role: "user", content: text },
      },
    ],
  });
}

async function createStoredSession(params: {
  prefix: string;
  sessionKey: string;
  sessionId: string;
  text?: string;
  updatedAt?: number;
}): Promise<void> {
  await createFixtureDir(params.prefix);
  await writeTranscript(params.sessionId, params.text);
  await writeSessionRows({
    [params.sessionKey]: {
      sessionId: params.sessionId,
      updatedAt: params.updatedAt ?? Date.now(),
    },
  });
}

type SessionResetConfig = NonNullable<NonNullable<OpenClawConfig["session"]>["reset"]>;

async function initStoredSessionState(params: {
  prefix: string;
  sessionKey: string;
  sessionId: string;
  text: string;
  updatedAt: number;
  reset?: SessionResetConfig;
}): Promise<void> {
  await createStoredSession(params);
  const cfg = {
    session: params.reset ? { reset: params.reset } : {},
  } as OpenClawConfig;

  await initSessionState({
    ctx: { Body: "hello", SessionKey: params.sessionKey },
    cfg,
    commandAuthorized: true,
  });
}

describe("session hook context wiring", () => {
  beforeEach(() => {
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runSessionStart.mockReset();
    hookRunnerMocks.runSessionEnd.mockReset();
    sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockClear();
    sessionCleanupMocks.resetRegisteredAgentHarnessSessions.mockClear();
    sessionCleanupMocks.retireSessionMcpRuntime.mockClear();
    hookRunnerMocks.runSessionStart.mockResolvedValue(undefined);
    hookRunnerMocks.runSessionEnd.mockResolvedValue(undefined);
    hookRunnerMocks.hasHooks.mockImplementation(
      (hookName) => hookName === "session_start" || hookName === "session_end",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
  });

  it("passes sessionKey to session_start hook context", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    await createFixtureDir("openclaw-session-hook-start");
    await writeSessionRows({});
    const cfg = { session: {} } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
    const [event, context] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
    expect(event).toMatchObject({ sessionKey });
    expect(context).toMatchObject({ sessionKey, agentId: "main" });
    expect(context).toMatchObject({ sessionId: event?.sessionId });
  });

  it("passes sessionKey to session_end hook context on reset", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    await createStoredSession({
      prefix: "openclaw-session-hook-end",
      sessionKey,
      sessionId: "old-session",
    });
    const cfg = { session: {} } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/new", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(hookRunnerMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
    const [event, context] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      sessionKey,
      reason: "new",
    });
    expect(context).toMatchObject({ sessionKey, agentId: "main" });
    expect(context).toMatchObject({ sessionId: event?.sessionId });
    expect(event).not.toHaveProperty("transcriptLocator");

    const [startEvent, startContext] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
    expect(startEvent).toMatchObject({ resumedFrom: "old-session" });
    expect(event?.nextSessionId).toBe(startEvent?.sessionId);
    expect(startContext).toMatchObject({ sessionId: startEvent?.sessionId });
  });

  it("marks explicit /reset rollovers with reason reset", async () => {
    const sessionKey = "agent:main:telegram:direct:456";
    await createStoredSession({
      prefix: "openclaw-session-hook-explicit-reset",
      sessionKey,
      sessionId: "reset-session",
      text: "reset me",
    });
    const cfg = { session: {} } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/reset", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({ reason: "reset" });
  });

  it("maps custom reset trigger aliases to the new-session reason", async () => {
    const sessionKey = "agent:main:telegram:direct:alias";
    await createStoredSession({
      prefix: "openclaw-session-hook-reset-alias",
      sessionKey,
      sessionId: "alias-session",
      text: "alias me",
    });
    const cfg = {
      session: {
        resetTriggers: ["/fresh"],
      },
    } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/fresh", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({ reason: "new" });
  });

  it("marks daily stale rollovers without exposing a transcript locator", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const sessionKey = "agent:main:telegram:direct:daily";
      await initStoredSessionState({
        prefix: "openclaw-session-hook-daily",
        sessionKey,
        sessionId: "daily-session",
        text: "daily",
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      });

      const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
      const [startEvent] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
      expect(event).toMatchObject({
        reason: "daily",
      });
      expect(event).not.toHaveProperty("transcriptLocator");
      expect(event?.nextSessionId).toBe(startEvent?.sessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks idle stale rollovers with reason idle", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const sessionKey = "agent:main:telegram:direct:idle";
      await initStoredSessionState({
        prefix: "openclaw-session-hook-idle",
        sessionKey,
        sessionId: "idle-session",
        text: "idle",
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        reset: {
          mode: "idle",
          idleMinutes: 30,
        },
      });

      const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
      expect(event).toMatchObject({ reason: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers idle over daily when both rollover conditions are true", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
      const sessionKey = "agent:main:telegram:direct:overlap";
      await initStoredSessionState({
        prefix: "openclaw-session-hook-overlap",
        sessionKey,
        sessionId: "overlap-session",
        text: "overlap",
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 30,
        },
      });

      const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
      expect(event).toMatchObject({ reason: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });
});
