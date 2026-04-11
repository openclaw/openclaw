import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../config/sessions/store.js", () => ({
  loadSessionStore: vi.fn(),
  archiveRemovedSessionTranscripts: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
}));

vi.mock("../../config/sessions/reset.js", () => ({
  evaluateSessionFreshness: vi.fn().mockReturnValue({ fresh: true }),
  resolveSessionResetPolicy: vi.fn().mockReturnValue({ mode: "idle", idleMinutes: 60 }),
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot: vi.fn(),
  clearBootstrapSnapshotOnSessionRollover: vi.fn(({ sessionKey, previousSessionId }) => {
    if (sessionKey && previousSessionId) {
      clearBootstrapSnapshot(sessionKey);
    }
  }),
}));

import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { evaluateSessionFreshness } from "../../config/sessions/reset.js";
import {
  archiveRemovedSessionTranscripts,
  loadSessionStore,
} from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  archivePriorIsolatedEntryAfterRotation,
  capturePriorIsolatedEntryForArchival,
  resolveCronSession,
} from "./session.js";

const NOW_MS = 1_737_600_000_000;

type SessionStore = ReturnType<typeof loadSessionStore>;
type SessionStoreEntry = SessionStore[string];
type MockSessionStoreEntry = Partial<SessionStoreEntry>;

function resolveWithStoredEntry(params?: {
  sessionKey?: string;
  entry?: MockSessionStoreEntry;
  forceNew?: boolean;
  fresh?: boolean;
}) {
  const sessionKey = params?.sessionKey ?? "webhook:stable-key";
  const store: SessionStore = params?.entry
    ? ({ [sessionKey]: params.entry as SessionStoreEntry } as SessionStore)
    : {};
  vi.mocked(loadSessionStore).mockReturnValue(store);
  vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: params?.fresh ?? true });

  return resolveCronSession({
    cfg: {} as OpenClawConfig,
    sessionKey,
    agentId: "main",
    nowMs: NOW_MS,
    forceNew: params?.forceNew,
  });
}

describe("resolveCronSession", () => {
  beforeEach(() => {
    vi.mocked(clearBootstrapSnapshot).mockReset();
  });

  it("preserves modelOverride and providerOverride from existing session entry", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:test-job",
      entry: {
        sessionId: "old-session-id",
        updatedAt: 1000,
        modelOverride: "deepseek-v3-4bit-mlx",
        providerOverride: "inferencer",
        thinkingLevel: "high",
        model: "kimi-code",
      },
    });

    expect(result.sessionEntry.modelOverride).toBe("deepseek-v3-4bit-mlx");
    expect(result.sessionEntry.providerOverride).toBe("inferencer");
    expect(result.sessionEntry.thinkingLevel).toBe("high");
    // The model field (last-used model) should also be preserved
    expect(result.sessionEntry.model).toBe("kimi-code");
  });

  it("handles missing modelOverride gracefully", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:test-job",
      entry: {
        sessionId: "old-session-id",
        updatedAt: 1000,
        model: "claude-opus-4-6",
      },
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
  });

  it("handles no existing session entry", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:new-job",
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
    expect(result.sessionEntry.model).toBeUndefined();
    expect(result.isNewSession).toBe(true);
  });

  // New tests for session reuse behavior (#18027)
  describe("session reuse for webhooks/cron", () => {
    it("reuses existing sessionId when session is fresh", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-123",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
        },
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).toBe("existing-session-id-123");
      expect(result.isNewSession).toBe(false);
      expect(result.systemSent).toBe(true);
      expect(clearBootstrapSnapshot).not.toHaveBeenCalled();
    });

    it("creates new sessionId when session is stale", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000, // 1 day ago
          systemSent: true,
          modelOverride: "gpt-4.1-mini",
          providerOverride: "openai",
          sendPolicy: "allow",
        },
        fresh: false,
      });

      expect(result.sessionEntry.sessionId).not.toBe("old-session-id");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("gpt-4.1-mini");
      expect(result.sessionEntry.providerOverride).toBe("openai");
      expect(result.sessionEntry.sendPolicy).toBe("allow");
      expect(clearBootstrapSnapshot).toHaveBeenCalledWith("webhook:stable-key");
    });

    it("creates new sessionId when forceNew is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-456",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          modelOverride: "sonnet-4",
          providerOverride: "anthropic",
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("existing-session-id-456");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("sonnet-4");
      expect(result.sessionEntry.providerOverride).toBe("anthropic");
      expect(clearBootstrapSnapshot).toHaveBeenCalledWith("webhook:stable-key");
    });

    it("clears delivery routing metadata and deliveryContext when forceNew is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-789",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastAccountId: "acct-123",
          lastThreadId: "1737500000.123456",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.123456",
          },
          modelOverride: "gpt-5.4",
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.isNewSession).toBe(true);
      // Delivery routing state must be cleared to prevent thread leaking.
      // deliveryContext must also be cleared because normalizeSessionEntryDelivery
      // repopulates lastThreadId from deliveryContext.threadId on store writes.
      expect(result.sessionEntry.lastChannel).toBeUndefined();
      expect(result.sessionEntry.lastTo).toBeUndefined();
      expect(result.sessionEntry.lastAccountId).toBeUndefined();
      expect(result.sessionEntry.lastThreadId).toBeUndefined();
      expect(result.sessionEntry.deliveryContext).toBeUndefined();
      // Per-session overrides must be preserved
      expect(result.sessionEntry.modelOverride).toBe("gpt-5.4");
    });

    it("clears delivery routing metadata when session is stale", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastThreadId: "1737500000.999999",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.999999",
          },
        },
        fresh: false,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.lastChannel).toBeUndefined();
      expect(result.sessionEntry.lastTo).toBeUndefined();
      expect(result.sessionEntry.lastAccountId).toBeUndefined();
      expect(result.sessionEntry.lastThreadId).toBeUndefined();
      expect(result.sessionEntry.deliveryContext).toBeUndefined();
    });

    it("preserves delivery routing metadata when reusing fresh session", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-101",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastThreadId: "1737500000.123456",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.123456",
          },
        },
        fresh: true,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionEntry.lastChannel).toBe("slack");
      expect(result.sessionEntry.lastTo).toBe("channel:C0XXXXXXXXX");
      expect(result.sessionEntry.lastThreadId).toBe("1737500000.123456");
      expect(result.sessionEntry.deliveryContext).toEqual({
        channel: "slack",
        to: "channel:C0XXXXXXXXX",
        threadId: "1737500000.123456",
      });
    });

    it("creates new sessionId when entry exists but has no sessionId", () => {
      const result = resolveWithStoredEntry({
        entry: {
          updatedAt: NOW_MS - 1000,
          modelOverride: "some-model",
        },
      });

      expect(result.sessionEntry.sessionId).toBeDefined();
      expect(result.isNewSession).toBe(true);
      // Should still preserve other fields from entry
      expect(result.sessionEntry.modelOverride).toBe("some-model");
    });

    describe("sessionFile rotation", () => {
      // Regression for the `isolatedSession: true` bug where every forceNew
      // run inherited the prior entry's sessionFile via the `...entry` spread.
      // `resolveSessionFilePath` prefers `entry.sessionFile` over recomputing
      // from sessionId, so the inherited path won over the new sessionId and
      // every run silently appended to the same physical transcript file
      // forever — defeating isolation and poisoning each run with the
      // in-context history of all prior runs.

      it("clears sessionFile when forceNew is true", () => {
        const result = resolveWithStoredEntry({
          sessionKey: "agent:main:main:heartbeat",
          entry: {
            sessionId: "old-heartbeat-session-id",
            updatedAt: NOW_MS - 1000,
            sessionFile: "/tmp/agents/main/sessions/old-heartbeat-session-id.jsonl",
          },
          fresh: true,
          forceNew: true,
        });

        expect(result.isNewSession).toBe(true);
        expect(result.sessionEntry.sessionId).not.toBe("old-heartbeat-session-id");
        // Must be undefined so the downstream resolver falls through to
        // computing a new path from the new sessionId.
        expect(result.sessionEntry.sessionFile).toBeUndefined();
      });

      it("clears sessionFile when session is stale (non-forceNew)", () => {
        const result = resolveWithStoredEntry({
          entry: {
            sessionId: "old-session-id",
            updatedAt: NOW_MS - 86_400_000,
            sessionFile: "/tmp/agents/main/sessions/old-session-id.jsonl",
          },
          fresh: false,
        });

        expect(result.isNewSession).toBe(true);
        expect(result.sessionEntry.sessionFile).toBeUndefined();
      });

      it("preserves sessionFile when reusing a fresh session", () => {
        const result = resolveWithStoredEntry({
          entry: {
            sessionId: "existing-session-id-202",
            updatedAt: NOW_MS - 1000,
            systemSent: true,
            sessionFile: "/tmp/agents/main/sessions/existing-session-id-202.jsonl",
          },
          fresh: true,
        });

        expect(result.isNewSession).toBe(false);
        // Reuse path must not rotate — subsequent writes go to the same file.
        expect(result.sessionEntry.sessionFile).toBe(
          "/tmp/agents/main/sessions/existing-session-id-202.jsonl",
        );
      });

      it("leaves sessionFile undefined when no prior entry exists (first-ever run)", () => {
        const result = resolveWithStoredEntry({
          forceNew: true,
          // No entry seeded — first-ever run.
        });

        expect(result.isNewSession).toBe(true);
        expect(result.sessionEntry.sessionFile).toBeUndefined();
      });
    });
  });
});

describe("capturePriorIsolatedEntryForArchival", () => {
  it("returns the prior entry identity when isNewSession and prior entry exists", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main:heartbeat": {
        sessionId: "prior-id",
        updatedAt: 0,
        sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
      } as SessionEntry,
    };
    const result = capturePriorIsolatedEntryForArchival({
      store,
      sessionKey: "agent:main:main:heartbeat",
      isNewSession: true,
    });
    expect(result).toEqual({
      sessionId: "prior-id",
      sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
    });
  });

  it("returns undefined when isNewSession is false (reuse path)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main:heartbeat": {
        sessionId: "existing-id",
        updatedAt: 0,
        sessionFile: "/tmp/agents/main/sessions/existing-id.jsonl",
      } as SessionEntry,
    };
    const result = capturePriorIsolatedEntryForArchival({
      store,
      sessionKey: "agent:main:main:heartbeat",
      isNewSession: false,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the store has no entry at the key (first-ever run)", () => {
    const result = capturePriorIsolatedEntryForArchival({
      store: {},
      sessionKey: "agent:main:main:heartbeat",
      isNewSession: true,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the prior entry has no sessionId", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main:heartbeat": {
        updatedAt: 0,
      } as unknown as SessionEntry,
    };
    const result = capturePriorIsolatedEntryForArchival({
      store,
      sessionKey: "agent:main:main:heartbeat",
      isNewSession: true,
    });
    expect(result).toBeUndefined();
  });

  it("captures sessionId even when sessionFile is undefined (legacy row)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main:heartbeat": {
        sessionId: "legacy-id",
        updatedAt: 0,
      } as SessionEntry,
    };
    const result = capturePriorIsolatedEntryForArchival({
      store,
      sessionKey: "agent:main:main:heartbeat",
      isNewSession: true,
    });
    expect(result).toEqual({ sessionId: "legacy-id", sessionFile: undefined });
  });
});

describe("archivePriorIsolatedEntryAfterRotation", () => {
  beforeEach(() => {
    vi.mocked(archiveRemovedSessionTranscripts).mockClear();
    vi.mocked(archiveRemovedSessionTranscripts).mockResolvedValue(new Set());
  });

  it("is a no-op when priorEntryForArchival is undefined", async () => {
    await archivePriorIsolatedEntryAfterRotation({
      priorEntryForArchival: undefined,
      store: {},
      storePath: "/tmp/test-store.json",
    });
    expect(archiveRemovedSessionTranscripts).not.toHaveBeenCalled();
  });

  it("invokes archival with reason 'reset' and restrictToStoreDir", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main:heartbeat": {
        sessionId: "new-id",
        updatedAt: 0,
        sessionFile: "/tmp/agents/main/sessions/new-id.jsonl",
      } as SessionEntry,
    };
    await archivePriorIsolatedEntryAfterRotation({
      priorEntryForArchival: {
        sessionId: "prior-id",
        sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
      },
      store,
      storePath: "/tmp/test-store.json",
    });
    expect(archiveRemovedSessionTranscripts).toHaveBeenCalledTimes(1);
    const call = vi.mocked(archiveRemovedSessionTranscripts).mock.calls[0]?.[0];
    expect(call?.reason).toBe("reset");
    expect(call?.restrictToStoreDir).toBe(true);
    expect(call?.storePath).toBe("/tmp/test-store.json");
    // removedSessionFiles must contain exactly the prior entry's (id, file).
    const entries = Array.from(call?.removedSessionFiles ?? []);
    expect(entries).toEqual([["prior-id", "/tmp/agents/main/sessions/prior-id.jsonl"]]);
    // referencedSessionIds must reflect the post-rotation store state (new id).
    expect(call?.referencedSessionIds.has("new-id")).toBe(true);
    expect(call?.referencedSessionIds.has("prior-id")).toBe(false);
  });

  it("passes undefined sessionFile through for legacy rows", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main:heartbeat": {
        sessionId: "new-id",
        updatedAt: 0,
      } as SessionEntry,
    };
    await archivePriorIsolatedEntryAfterRotation({
      priorEntryForArchival: { sessionId: "legacy-id", sessionFile: undefined },
      store,
      storePath: "/tmp/test-store.json",
    });
    expect(archiveRemovedSessionTranscripts).toHaveBeenCalledTimes(1);
    const call = vi.mocked(archiveRemovedSessionTranscripts).mock.calls[0]?.[0];
    const entries = Array.from(call?.removedSessionFiles ?? []);
    // sessionFile is undefined — archiveRemovedSessionTranscripts accepts this
    // and falls back to deriving candidates from sessionId + storePath.
    expect(entries).toEqual([["legacy-id", undefined]]);
  });

  it("archival is still invoked when the prior sessionId happens to remain in the store", async () => {
    // Safety path: archiveRemovedSessionTranscripts internally skips any
    // sessionId still in referencedSessionIds, so passing the prior id
    // through is safe even if (pathologically) two entries share it.
    const store: Record<string, SessionEntry> = {
      "agent:main:main:heartbeat": {
        sessionId: "prior-id",
        updatedAt: 0,
        sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
      } as SessionEntry,
      "agent:main:main:heartbeat:run:abc": {
        sessionId: "prior-id",
        updatedAt: 0,
      } as SessionEntry,
    };
    await archivePriorIsolatedEntryAfterRotation({
      priorEntryForArchival: {
        sessionId: "prior-id",
        sessionFile: "/tmp/agents/main/sessions/prior-id.jsonl",
      },
      store,
      storePath: "/tmp/test-store.json",
    });
    expect(archiveRemovedSessionTranscripts).toHaveBeenCalledTimes(1);
    const call = vi.mocked(archiveRemovedSessionTranscripts).mock.calls[0]?.[0];
    // referencedSessionIds contains the prior-id because it's still in the
    // store — archival will internally skip it (safety).
    expect(call?.referencedSessionIds.has("prior-id")).toBe(true);
  });
});
