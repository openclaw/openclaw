import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createSqliteSessionTranscriptLocator } from "../../config/sessions.js";
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
  const transcriptPath = path.join(root, "transcripts", "s1.jsonl");
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "s1",
    transcriptPath,
    events: [{ type: "message" }],
  });
  const entry = {
    sessionId: "s1",
    sessionFile: transcriptPath,
    updatedAt: Date.now(),
    compactionCount: 0,
  } as SessionEntry;
  const sessionStore: Record<string, SessionEntry> = {
    [sessionKey]: entry,
  };
  upsertSessionEntry({ agentId: "main", sessionKey, entry });
  return { sessionKey, sessionStore, entry, transcriptPath };
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
    const { sessionKey, sessionStore, entry, transcriptPath } = await createFixture();
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

    const [endEvent, endContext] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    const [startEvent, startContext] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];

    expect(endEvent).toMatchObject({
      sessionId: "s1",
      sessionKey,
      reason: "compaction",
    });
    expect(endEvent?.sessionFile).toBe(path.resolve(transcriptPath));
    expect(endContext).toMatchObject({
      sessionId: "s1",
      sessionKey,
      agentId: "main",
    });
    expect(endEvent?.nextSessionId).toBe(startEvent?.sessionId);
    expect(startEvent).toMatchObject({
      sessionId: "s2",
      sessionKey,
      resumedFrom: "s1",
    });
    expect(startContext).toMatchObject({
      sessionId: "s2",
      sessionKey,
      agentId: "main",
    });
  });

  it("keeps SQLite transcript locators virtual when compaction rotates topic sessions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-updates-sqlite-"));
    tempDirs.push(root);
    if (!previousStateDirCaptured) {
      previousStateDir = process.env.OPENCLAW_STATE_DIR;
      previousStateDirCaptured = true;
    }
    process.env.OPENCLAW_STATE_DIR = root;
    const sessionKey = "agent:main:forum:direct:compaction:topic:456";
    const sessionFile = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "s1",
      topicId: 456,
    });
    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: "s1",
      transcriptPath: sessionFile,
      events: [{ type: "message" }],
    });
    const entry = {
      sessionId: "s1",
      sessionFile,
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

    const expectedNextFile = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "s2",
      topicId: 456,
    });
    expect(sessionStore[sessionKey]?.sessionFile).toBe(expectedNextFile);
    expect(sessionStore[sessionKey]?.sessionFile).toContain("sqlite-transcript://");
    expect(sessionStore[sessionKey]?.sessionFile).not.toMatch(/^sqlite-transcript:\/[^/]/u);
    const [endEvent] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    expect(endEvent?.sessionFile).toBe(sessionFile);
  });
});
