import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionTranscriptLocator, type SessionEntry } from "../../config/sessions.js";
import { replaceSqliteSessionTranscriptEvents } from "../../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createPersistCronSessionEntry, type MutableCronSession } from "./run-session-state.js";

let testStateDir = "";

beforeEach(async () => {
  testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-session-state-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", testStateDir);
});

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  await fs.rm(testStateDir, { recursive: true, force: true });
  testStateDir = "";
});

function makeSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "run-session-id",
    updatedAt: 1000,
    systemSent: true,
    ...overrides,
  };
}

function makeCronSession(entry = makeSessionEntry()): MutableCronSession {
  return {
    store: {},
    sessionEntry: entry,
    systemSent: true,
    isNewSession: true,
    previousSessionId: undefined,
  } as MutableCronSession;
}

describe("createPersistCronSessionEntry", () => {
  it("persists isolated cron state only under the stable cron session key", async () => {
    const cronSession = makeCronSession(
      makeSessionEntry({
        status: "running",
        startedAt: 900,
        skillsSnapshot: {
          prompt: "old prompt",
          skills: [{ name: "memory" }],
        },
      }),
    );
    const persistSessionRow = vi.fn(async (sessionKey: string, entry: SessionEntry) => {
      expect(sessionKey).toBe("agent:main:cron:job");
      expect(entry).toBe(cronSession.sessionEntry);
    });

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:job",
      persistSessionRow,
    });

    await persist();

    expect(cronSession.store["agent:main:cron:job"]).toBe(cronSession.sessionEntry);
    expect(cronSession.store["agent:main:cron:job:run:run-session-id"]).toBeUndefined();
  });

  it("does not register cron sessions as resumable until the transcript exists", async () => {
    const missingTranscriptPath = path.join(
      os.tmpdir(),
      `openclaw-missing-cron-${crypto.randomUUID()}.jsonl`,
    );
    const cronSession = makeCronSession(
      makeSessionEntry({
        label: "Cron: shell-only",
        status: "running",
      }),
    );
    const persistSessionRow = vi.fn(async (sessionKey: string, entry: SessionEntry) => {
      expect(sessionKey).toBe("agent:main:cron:shell-only");
      expect(entry).toEqual(
        expect.objectContaining({
          label: "Cron: shell-only",
          status: "running",
          updatedAt: 1000,
        }),
      );
      expect(entry.sessionId).toBeUndefined();
      expect(entry).not.toHaveProperty("transcriptLocator");
    });

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:shell-only",
      persistSessionRow,
    });

    await persist();

    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionId).toBeUndefined();
    expect(cronSession.store["agent:main:cron:shell-only"]).not.toHaveProperty("transcriptLocator");
  });

  it("restores resumable cron fields once the transcript exists", async () => {
    const transcriptPath = seedCronTranscript();
    const cronSession = makeCronSession(
      makeSessionEntry({
        label: "Cron: completed",
      }),
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:completed",
      persistSessionRow: vi.fn(async (sessionKey: string, entry: SessionEntry) => {
        expect(sessionKey).toBe("agent:main:cron:completed");
        expect(entry).toMatchObject({
          sessionId: "run-session-id",
          label: "Cron: completed",
        });
      }),
    });

    await persist();

    expect(cronSession.store["agent:main:cron:completed"]).toMatchObject({
      sessionId: "run-session-id",
    });
  });

  it("persists explicit session-bound cron state under the requested session key", async () => {
    const cronSession = makeCronSession();
    const persistSessionRow = vi.fn(async (sessionKey: string, entry: SessionEntry) => {
      expect(sessionKey).toBe("agent:main:session");
      expect(entry).toBe(cronSession.sessionEntry);
    });

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:session",
      persistSessionRow,
    });

    await persist();

    expect(cronSession.store["agent:main:session"]).toBe(cronSession.sessionEntry);
  });
});

function seedCronTranscript(): string {
  const transcriptLocator = createSqliteSessionTranscriptLocator({
    agentId: "main",
    sessionId: "run-session-id",
  });
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "run-session-id",
    events: [
      {
        type: "session",
        id: "run-session-id",
        timestamp: new Date(0).toISOString(),
        cwd: testStateDir,
      },
    ],
  });
  return transcriptLocator;
}
