// Verifies that cron run finalization supersedes the per-call context totals a run publishes.
import { describe, expect, it, vi } from "vitest";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions.js";

// mock-isolation: Keep the workspace loader, state database and process-wide bootstrap cache outside this fixture.
vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshotOnSessionBoundary: vi.fn(),
}));
import {
  createPersistCronSessionEntry,
  type CronSessionRowWriter,
  type MutableCronSession,
} from "./run-session-state.js";

describe("createPersistCronSessionEntry context total", () => {
  it("lets run finalization, not a stale snapshot, replace per-call context totals", async () => {
    const lifecycleRevision = "00000000-0000-4000-8000-000000000003";
    const existingEntry: SessionEntry = {
      sessionId: "run-session-id",
      updatedAt: 1000,
      systemSent: true,
      lifecycleRevision,
      totalTokens: 900,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    };
    const cronSession = {
      storePath: "/tmp/sessions.json",
      store: {},
      sessionEntry: { ...existingEntry },
      systemSent: true,
      isNewSession: true,
      previousSessionId: undefined,
      initialSessionEntry: existingEntry,
      lifecycleRevision,
    } as MutableCronSession;
    const sessionKey = "agent:main:cron:job";
    const persistedStore: Record<string, SessionEntry> = { [sessionKey]: existingEntry };
    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: sessionKey,
      workspaceDir: "/tmp/workspace",
      persistSessionEntry: vi.fn<CronSessionRowWriter>(async (params) => {
        persistedStore[params.sessionKey] = params.update(persistedStore[params.sessionKey]);
      }),
    });

    // A per-call publication lands before the next candidate persists its snapshot.
    persistedStore[sessionKey] = { ...existingEntry, totalTokens: 185_000 };
    await persist();
    expect(persistedStore[sessionKey]?.totalTokens).toBe(185_000);

    persistedStore[sessionKey] = { ...persistedStore[sessionKey]!, totalTokens: 190_000 };
    // Run finalization records the run's final context total.
    cronSession.sessionEntry.totalTokens = 120_000;
    cronSession.contextTotalsAccounted = true;
    await persist();
    expect(persistedStore[sessionKey]).toMatchObject({
      totalTokens: 120_000,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    });
  });
});
