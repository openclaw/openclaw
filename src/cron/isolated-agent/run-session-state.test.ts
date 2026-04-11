import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the session.js helpers at module level so createPersistCronSessionEntry
// sees fakes. Using factory so we can observe call arguments in each test.
vi.mock("./session.js", () => ({
  capturePriorIsolatedEntryForArchival: vi.fn(),
  archivePriorIsolatedEntryAfterRotation: vi.fn().mockResolvedValue(undefined),
}));

import type { SessionEntry } from "../../config/sessions.js";
import { createPersistCronSessionEntry } from "./run-session-state.js";
import type { MutableCronSession } from "./run-session-state.js";
import {
  archivePriorIsolatedEntryAfterRotation,
  capturePriorIsolatedEntryForArchival,
} from "./session.js";

type MutableStore = Record<string, SessionEntry>;

function makeCronSession(params: {
  storePath?: string;
  agentSessionKey: string;
  initialStore?: MutableStore;
  newSessionEntry: SessionEntry;
  isNewSession: boolean;
}): MutableCronSession {
  const store: MutableStore = params.initialStore
    ? structuredClone(params.initialStore)
    : {};
  return {
    storePath: params.storePath ?? "/tmp/test-sessions.json",
    store,
    sessionEntry: params.newSessionEntry,
    systemSent: false,
    isNewSession: params.isNewSession,
  } as unknown as MutableCronSession;
}

describe("createPersistCronSessionEntry", () => {
  beforeEach(() => {
    vi.mocked(capturePriorIsolatedEntryForArchival).mockReset();
    vi.mocked(archivePriorIsolatedEntryAfterRotation).mockReset();
    vi.mocked(archivePriorIsolatedEntryAfterRotation).mockResolvedValue(undefined);
  });

  it("writes the new entry to agentSessionKey and calls updateSessionStore", async () => {
    const agentSessionKey = "agent:main:main";
    const newEntry: SessionEntry = {
      sessionId: "new-id",
      updatedAt: 42,
    } as SessionEntry;
    const cronSession = makeCronSession({
      agentSessionKey,
      newSessionEntry: newEntry,
      isNewSession: true,
    });
    const updateSessionStore = vi.fn().mockResolvedValue(undefined);
    vi.mocked(capturePriorIsolatedEntryForArchival).mockReturnValue(undefined);

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey,
      runSessionKey: agentSessionKey,
      updateSessionStore,
    });
    await persist();

    expect(cronSession.store[agentSessionKey]).toBe(newEntry);
    expect(updateSessionStore).toHaveBeenCalledTimes(1);
  });

  it("also writes to runSessionKey when it differs from agentSessionKey", async () => {
    const agentSessionKey = "agent:main:cron:job-xyz";
    const runSessionKey = "agent:main:cron:job-xyz:run:run-123";
    const newEntry: SessionEntry = {
      sessionId: "new-id",
      updatedAt: 42,
    } as SessionEntry;
    const cronSession = makeCronSession({
      agentSessionKey,
      newSessionEntry: newEntry,
      isNewSession: true,
    });
    const updateSessionStore = vi.fn(async (_path, update) => {
      update(cronSession.store);
    });
    vi.mocked(capturePriorIsolatedEntryForArchival).mockReturnValue(undefined);

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey,
      runSessionKey,
      updateSessionStore,
    });
    await persist();

    expect(cronSession.store[agentSessionKey]).toBe(newEntry);
    expect(cronSession.store[runSessionKey]).toBe(newEntry);
  });

  it("skips all writes in fast test env", async () => {
    const agentSessionKey = "agent:main:main";
    const cronSession = makeCronSession({
      agentSessionKey,
      newSessionEntry: { sessionId: "new", updatedAt: 0 } as SessionEntry,
      isNewSession: true,
    });
    const updateSessionStore = vi.fn();

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: true,
      cronSession,
      agentSessionKey,
      runSessionKey: agentSessionKey,
      updateSessionStore,
    });
    await persist();

    expect(updateSessionStore).not.toHaveBeenCalled();
    expect(cronSession.store[agentSessionKey]).toBeUndefined();
    expect(archivePriorIsolatedEntryAfterRotation).not.toHaveBeenCalled();
  });

  describe("rotation archival (hook-style, runSessionKey === agentSessionKey)", () => {
    it("captures the prior entry for archival at factory construction time", () => {
      const agentSessionKey = "agent:main:webhook:foo";
      const priorEntry: SessionEntry = {
        sessionId: "prior-id",
        updatedAt: 0,
        sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
      } as SessionEntry;
      const cronSession = makeCronSession({
        agentSessionKey,
        initialStore: { [agentSessionKey]: priorEntry },
        newSessionEntry: { sessionId: "new-id", updatedAt: 1 } as SessionEntry,
        isNewSession: true,
      });
      vi.mocked(capturePriorIsolatedEntryForArchival).mockReturnValue({
        sessionId: "prior-id",
        sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
      });

      createPersistCronSessionEntry({
        isFastTestEnv: false,
        cronSession,
        agentSessionKey,
        runSessionKey: agentSessionKey, // hook-style
        updateSessionStore: vi.fn().mockResolvedValue(undefined),
      });

      expect(capturePriorIsolatedEntryForArchival).toHaveBeenCalledTimes(1);
      const call = vi.mocked(capturePriorIsolatedEntryForArchival).mock.calls[0]?.[0];
      expect(call?.sessionKey).toBe(agentSessionKey);
      expect(call?.isNewSession).toBe(true);
      // IMPORTANT: the captured entry must be read BEFORE persist runs,
      // while the store still has the prior entry. Uses deep equality
      // (not reference equality) because `makeCronSession` structuredClones
      // the initial store to isolate tests from each other.
      expect(call?.store[agentSessionKey]).toEqual(priorEntry);
    });

    it("archives the prior transcript after the first persist call", async () => {
      const agentSessionKey = "agent:main:webhook:foo";
      const priorEntry: SessionEntry = {
        sessionId: "prior-id",
        updatedAt: 0,
        sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
      } as SessionEntry;
      const cronSession = makeCronSession({
        agentSessionKey,
        initialStore: { [agentSessionKey]: priorEntry },
        newSessionEntry: { sessionId: "new-id", updatedAt: 1 } as SessionEntry,
        isNewSession: true,
      });
      const capturedPrior = {
        sessionId: "prior-id",
        sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
      };
      vi.mocked(capturePriorIsolatedEntryForArchival).mockReturnValue(capturedPrior);

      const persist = createPersistCronSessionEntry({
        isFastTestEnv: false,
        cronSession,
        agentSessionKey,
        runSessionKey: agentSessionKey,
        updateSessionStore: vi.fn().mockResolvedValue(undefined),
      });
      await persist();

      expect(archivePriorIsolatedEntryAfterRotation).toHaveBeenCalledTimes(1);
      const call = vi.mocked(archivePriorIsolatedEntryAfterRotation).mock.calls[0]?.[0];
      expect(call?.priorEntryForArchival).toEqual(capturedPrior);
      expect(call?.storePath).toBe("/tmp/test-sessions.json");
      // The store passed to archival is the post-write state.
      expect(call?.store[agentSessionKey]?.sessionId).toBe("new-id");
    });

    it("archives exactly once across multiple persist calls (once-flag)", async () => {
      const agentSessionKey = "agent:main:webhook:foo";
      const cronSession = makeCronSession({
        agentSessionKey,
        initialStore: {
          [agentSessionKey]: {
            sessionId: "prior-id",
            updatedAt: 0,
            sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
          } as SessionEntry,
        },
        newSessionEntry: { sessionId: "new-id", updatedAt: 1 } as SessionEntry,
        isNewSession: true,
      });
      vi.mocked(capturePriorIsolatedEntryForArchival).mockReturnValue({
        sessionId: "prior-id",
        sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
      });

      const persist = createPersistCronSessionEntry({
        isFastTestEnv: false,
        cronSession,
        agentSessionKey,
        runSessionKey: agentSessionKey,
        updateSessionStore: vi.fn().mockResolvedValue(undefined),
      });

      // Three persist calls — common pattern during a run (pre-run snapshot,
      // skills refresh, finalize). Only the first should trigger archival.
      await persist();
      await persist();
      await persist();

      expect(archivePriorIsolatedEntryAfterRotation).toHaveBeenCalledTimes(1);
    });

    it("also captures prior entry for the cron: run-key path (runSessionKey !== agentSessionKey)", async () => {
      // When the runSessionKey is a distinct :run:<id> key, the new entry
      // is persisted at BOTH agentSessionKey AND runSessionKey. The prior
      // entry at agentSessionKey is still overwritten, so the prior
      // sessionFile becomes unreferenced — the session-reaper cleans up
      // :run:<id> entries on retention expiry but archives the NEW entry's
      // file, not the prior one. So the prior transcript also needs
      // rotation archival on this path.
      const agentSessionKey = "agent:main:cron:job-xyz";
      const runSessionKey = "agent:main:cron:job-xyz:run:run-123";
      const cronSession = makeCronSession({
        agentSessionKey,
        initialStore: {
          [agentSessionKey]: {
            sessionId: "prior-id",
            updatedAt: 0,
            sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
          } as SessionEntry,
        },
        newSessionEntry: { sessionId: "new-id", updatedAt: 1 } as SessionEntry,
        isNewSession: true,
      });
      vi.mocked(capturePriorIsolatedEntryForArchival).mockReturnValue({
        sessionId: "prior-id",
        sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
      });

      const persist = createPersistCronSessionEntry({
        isFastTestEnv: false,
        cronSession,
        agentSessionKey,
        runSessionKey,
        updateSessionStore: vi.fn().mockResolvedValue(undefined),
      });
      await persist();

      expect(capturePriorIsolatedEntryForArchival).toHaveBeenCalledTimes(1);
      const captureCall = vi.mocked(capturePriorIsolatedEntryForArchival).mock.calls[0]?.[0];
      expect(captureCall?.sessionKey).toBe(agentSessionKey);
      expect(archivePriorIsolatedEntryAfterRotation).toHaveBeenCalledTimes(1);
    });

    it("logs but does not throw when archival fails", async () => {
      const agentSessionKey = "agent:main:webhook:foo";
      const cronSession = makeCronSession({
        agentSessionKey,
        newSessionEntry: { sessionId: "new-id", updatedAt: 1 } as SessionEntry,
        isNewSession: true,
      });
      vi.mocked(capturePriorIsolatedEntryForArchival).mockReturnValue({
        sessionId: "prior-id",
        sessionFile: "/tmp/prior.jsonl",
      });
      vi.mocked(archivePriorIsolatedEntryAfterRotation).mockRejectedValue(
        new Error("disk write failed"),
      );
      const log = { warn: vi.fn() };

      const persist = createPersistCronSessionEntry({
        isFastTestEnv: false,
        cronSession,
        agentSessionKey,
        runSessionKey: agentSessionKey,
        updateSessionStore: vi.fn().mockResolvedValue(undefined),
        log,
      });

      // Must not throw — archival failure is logged and swallowed.
      await expect(persist()).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalledTimes(1);
      const [message, context] = log.warn.mock.calls[0] ?? [];
      expect(message).toContain("archive");
      expect(context?.err).toContain("disk write failed");
      expect(context?.priorSessionId).toBe("prior-id");
    });

    it("marks as archived even on failure so subsequent persists skip", async () => {
      const agentSessionKey = "agent:main:webhook:foo";
      const cronSession = makeCronSession({
        agentSessionKey,
        newSessionEntry: { sessionId: "new-id", updatedAt: 1 } as SessionEntry,
        isNewSession: true,
      });
      vi.mocked(capturePriorIsolatedEntryForArchival).mockReturnValue({
        sessionId: "prior-id",
        sessionFile: "/tmp/prior.jsonl",
      });
      vi.mocked(archivePriorIsolatedEntryAfterRotation).mockRejectedValue(
        new Error("disk write failed"),
      );

      const persist = createPersistCronSessionEntry({
        isFastTestEnv: false,
        cronSession,
        agentSessionKey,
        runSessionKey: agentSessionKey,
        updateSessionStore: vi.fn().mockResolvedValue(undefined),
        log: { warn: vi.fn() },
      });

      await persist();
      await persist();

      // Even though the first archive failed, the once-flag prevented the
      // second persist from retrying — we don't want unbounded retries on a
      // missing file, and subsequent retries would also fail the same way.
      expect(archivePriorIsolatedEntryAfterRotation).toHaveBeenCalledTimes(1);
    });
  });
});
