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

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runSessionEnd: vi.fn<HookRunner["runSessionEnd"]>(),
  runSessionStart: vi.fn<HookRunner["runSessionStart"]>(),
}));
const legacySessionFileProperty = ["session", "File"].join("");

let incrementCompactionCount: typeof import("./session-updates.js").incrementCompactionCount;
const tempDirs: string[] = [];
let previousStateDir: string | undefined;
let previousStateDirCaptured = false;

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-updates-"));
  tempDirs.push(root);
  if (!previousStateDirCaptured) {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    previousStateDirCaptured = true;
  }
  process.env.OPENCLAW_STATE_DIR = root;
  const sessionKey = "agent:main:forum:direct:compaction";
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "s1",
    events: [{ type: "message" }],
  });
  const entry = {
    sessionId: "s1",
    updatedAt: Date.now(),
    compactionCount: 0,
  } as SessionEntry;
  const sessionStore: Record<string, SessionEntry> = {
    [sessionKey]: entry,
  };
  upsertSessionEntry({ agentId: "main", sessionKey, entry });
  return { sessionKey, sessionStore, entry };
}

function firstSessionEndCall() {
  return hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
}

function firstSessionStartCall() {
  return hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
}

describe("session-updates lifecycle hooks", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../../plugins/hook-runner-global.js", () => ({
      getGlobalHookRunner: () =>
        ({
          hasHooks: hookRunnerMocks.hasHooks,
          runSessionEnd: hookRunnerMocks.runSessionEnd,
          runSessionStart: hookRunnerMocks.runSessionStart,
        }) as unknown as HookRunner,
    }));
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runSessionEnd.mockReset();
    hookRunnerMocks.runSessionStart.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation(
      (hookName) => hookName === "session_end" || hookName === "session_start",
    );
    hookRunnerMocks.runSessionEnd.mockResolvedValue(undefined);
    hookRunnerMocks.runSessionStart.mockResolvedValue(undefined);
    ({ incrementCompactionCount } = await import("./session-updates.js"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    previousStateDir = undefined;
    previousStateDirCaptured = false;
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("emits compaction lifecycle hooks when newSessionId replaces the session", async () => {
    const { sessionKey, sessionStore, entry } = await createFixture();
    const cfg = { session: {} } as OpenClawConfig;

    await incrementCompactionCount({
      cfg,
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      newSessionId: "s2",
    });

    expect(hookRunnerMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);

    const [endEvent, endContext] = firstSessionEndCall();
    const [startEvent, startContext] = firstSessionStartCall();

    expect(endEvent?.sessionId).toBe("s1");
    expect(endEvent?.sessionKey).toBe(sessionKey);
    expect(endEvent?.reason).toBe("compaction");
    expect(endEvent).not.toHaveProperty(legacySessionFileProperty);
    expect(endEvent).not.toHaveProperty("transcriptArchived");
    expect(endContext?.sessionId).toBe("s1");
    expect(endContext?.sessionKey).toBe(sessionKey);
    expect(endContext?.agentId).toBe("main");
    expect(endEvent?.nextSessionId).toBe(startEvent?.sessionId);
    expect(startEvent?.sessionId).toBe("s2");
    expect(startEvent?.sessionKey).toBe(sessionKey);
    expect(startEvent?.resumedFrom).toBe("s1");
    expect(startContext?.sessionId).toBe("s2");
    expect(startContext?.sessionKey).toBe(sessionKey);
    expect(startContext?.agentId).toBe("main");
  });

  it("keeps topic compaction identity out of active session rows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-updates-sqlite-"));
    tempDirs.push(root);
    if (!previousStateDirCaptured) {
      previousStateDir = process.env.OPENCLAW_STATE_DIR;
      previousStateDirCaptured = true;
    }
    process.env.OPENCLAW_STATE_DIR = root;
    const sessionKey = "agent:main:forum:direct:compaction:topic:456";
    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: "s1",
      events: [{ type: "message" }],
    });
    const entry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      compactionCount: 0,
    } as SessionEntry;
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: entry,
    };
    upsertSessionEntry({ agentId: "main", sessionKey, entry });
    const cfg = { session: {} } as OpenClawConfig;

    await incrementCompactionCount({
      cfg,
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      newSessionId: "s2",
    });

    expect(sessionStore[sessionKey]?.sessionId).toBe("s2");
    const [endEvent] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
  });
});
