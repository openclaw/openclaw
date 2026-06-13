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
  setCronSessionDeliveryContextFromResolvedDelivery,
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
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:cron:job"]).toBe(cronSession.sessionEntry);
        expect(store["agent:main:cron:job:run:run-session-id"]).toBeUndefined();
      },
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:job",
      updateSessionStore,
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
        sessionFile: missingTranscriptPath,
        label: "Cron: shell-only",
        status: "running",
      }),
    );
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:cron:shell-only"]).toEqual({
          label: "Cron: shell-only",
          status: "running",
          updatedAt: 1000,
          systemSent: true,
        });
      },
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:shell-only",
      updateSessionStore,
    });

    await persist();

    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionId).toBeUndefined();
    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionFile).toBeUndefined();
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
      updateSessionStore: vi.fn(
        async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
          const store: Record<string, SessionEntry> = {};
          update(store);
          expect(store["agent:main:cron:completed"]).toEqual({
            sessionId: "run-session-id",
            sessionFile: transcriptPath,
            label: "Cron: completed",
            updatedAt: 1000,
            systemSent: true,
          });
        },
      ),
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
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:session"]).toBe(cronSession.sessionEntry);
      },
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:session",
      updateSessionStore,
    });

    await persist();

    expect(cronSession.store["agent:main:session"]).toBe(cronSession.sessionEntry);
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
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:telegram:direct:42"]).toEqual({
          sessionId: "bound-session-rotated",
          sessionFile: "/tmp/bound-session-rotated.jsonl",
          usageFamilyKey: "agent:main:telegram:direct:42",
          usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
          updatedAt: 1000,
          systemSent: true,
        });
      },
    );

    expect(changed).toBe(true);
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:telegram:direct:42",
      updateSessionStore,
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
  });
});

describe("setCronSessionDeliveryContextFromResolvedDelivery", () => {
  it("persists a resolved explicit delivery target on the session entry", () => {
    const cronSession = makeCronSession();
    setCronSessionDeliveryContextFromResolvedDelivery(cronSession.sessionEntry, {
      ok: true,
      channel: "webchat",
      to: "user@example.com",
      accountId: "account-1",
      threadId: "thread-1",
      mode: "explicit",
    });
    expect(cronSession.sessionEntry.deliveryContext).toEqual({
      channel: "webchat",
      to: "user@example.com",
      accountId: "account-1",
      threadId: "thread-1",
    });
  });

  it("persists the resolved target without optional account/thread fields", () => {
    const cronSession = makeCronSession();
    setCronSessionDeliveryContextFromResolvedDelivery(cronSession.sessionEntry, {
      ok: true,
      channel: "webchat",
      to: "user@example.com",
      mode: "explicit",
    });
    expect(cronSession.sessionEntry.deliveryContext).toEqual({
      channel: "webchat",
      to: "user@example.com",
    });
  });

  it("leaves deliveryContext unchanged when target resolution fails", () => {
    const cronSession = makeCronSession(
      makeSessionEntry({ deliveryContext: { channel: "webchat", to: "stale" } }),
    );
    setCronSessionDeliveryContextFromResolvedDelivery(cronSession.sessionEntry, {
      ok: false,
      channel: undefined,
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit",
      error: new Error("Channel is required"),
    });
    expect(cronSession.sessionEntry.deliveryContext).toEqual({
      channel: "webchat",
      to: "stale",
    });
  });

  it("does not create an empty deliveryContext when the resolved target has no routable channel", () => {
    const cronSession = makeCronSession();
    setCronSessionDeliveryContextFromResolvedDelivery(cronSession.sessionEntry, {
      ok: true,
      channel: "webchat",
      to: "",
      mode: "explicit",
    });
    expect(cronSession.sessionEntry.deliveryContext).toBeUndefined();
  });
});

async function createTranscriptFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-session-"));
  const file = path.join(dir, "session.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ type: "session", sessionId: "run-session-id" })}\n`);
  return file;
}
