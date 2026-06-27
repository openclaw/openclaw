// Run session state tests cover persisted session state for isolated cron agents.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  adoptCronRunSessionMetadata,
  createPersistCronSessionEntry,
  type MutableCronSession,
} from "./run-session-state.js";

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
    storePath: "/tmp/sessions.json",
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
        sessionFile: await createTranscriptFile(),
        status: "running",
        startedAt: 900,
        skillsSnapshot: {
          prompt: "old prompt",
          skills: [{ name: "memory" }],
        },
      }),
    );
    const persistSessionEntry = vi.fn(async () => {});

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:job",
      persistSessionEntry,
    });

    await persist();

    expect(cronSession.store["agent:main:cron:job"]).toBe(cronSession.sessionEntry);
    expect(cronSession.store["agent:main:cron:job:run:run-session-id"]).toBeUndefined();
    expect(persistSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:cron:job",
      entry: cronSession.sessionEntry,
    });
  });

  it("does not register cron sessions as resumable until the transcript exists", async () => {
    const missingTranscriptPath = path.join(
      os.tmpdir(),
      `openclaw-missing-cron-${crypto.randomUUID()}.jsonl`,
    );
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionFile: missingTranscriptPath,
        label: "Cron: shell-only",
        status: "running",
      }),
    );
    const persistSessionEntry = vi.fn(async () => {});

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:shell-only",
      persistSessionEntry,
    });

    await persist();

    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionId).toBe("run-session-id");
    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionFile).toBeUndefined();
    expect(persistSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:cron:shell-only",
      entry: {
        label: "Cron: shell-only",
        sessionId: "run-session-id",
        status: "running",
        updatedAt: 1000,
        systemSent: true,
      },
    });
  });

  it("restores resumable cron fields once the transcript exists", async () => {
    const transcriptPath = await createTranscriptFile();
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionFile: transcriptPath,
        label: "Cron: completed",
      }),
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:completed",
      persistSessionEntry: vi.fn(async () => {}),
    });

    await persist();

    expect(cronSession.store["agent:main:cron:completed"]).toEqual({
      sessionId: "run-session-id",
      sessionFile: transcriptPath,
      label: "Cron: completed",
      updatedAt: 1000,
      systemSent: true,
    });
  });

  it("persists explicit session-bound cron state under the requested session key", async () => {
    const cronSession = makeCronSession();
    const persistSessionEntry = vi.fn(async () => {});

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:session",
      persistSessionEntry,
    });

    await persist();

    expect(cronSession.store["agent:main:session"]).toBe(cronSession.sessionEntry);
    expect(persistSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:session",
      entry: cronSession.sessionEntry,
    });
  });

  it("adopts rotated run transcript metadata before persisting session-bound cron state", async () => {
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionId: "bound-session",
        sessionFile: "/tmp/bound-session.jsonl",
      }),
    );
    const changed = adoptCronRunSessionMetadata({
      entry: cronSession.sessionEntry,
      sessionKey: "agent:main:telegram:direct:42",
      runMeta: {
        sessionId: "bound-session-rotated",
        sessionFile: "/tmp/bound-session-rotated.jsonl",
      },
    });
    const persistSessionEntry = vi.fn(async () => {});

    expect(changed).toBe(true);
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:telegram:direct:42",
      persistSessionEntry,
    });

    await persist();

    expect(cronSession.store["agent:main:telegram:direct:42"]).toEqual({
      sessionId: "bound-session-rotated",
      sessionFile: "/tmp/bound-session-rotated.jsonl",
      usageFamilyKey: "agent:main:telegram:direct:42",
      usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
      updatedAt: 1000,
      systemSent: true,
    });
    expect(persistSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:telegram:direct:42",
      entry: {
        sessionId: "bound-session-rotated",
        sessionFile: "/tmp/bound-session-rotated.jsonl",
        usageFamilyKey: "agent:main:telegram:direct:42",
        usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
        updatedAt: 1000,
        systemSent: true,
      },
    });
  });
});

async function createTranscriptFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-session-"));
  const file = path.join(dir, "session.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ type: "session", sessionId: "run-session-id" })}\n`);
  return file;
}
