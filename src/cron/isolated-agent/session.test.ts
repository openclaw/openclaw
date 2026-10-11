import { describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionOrigin } from "../../config/sessions/types.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import { projectSessionDeliveryFields } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: vi.fn().mockReturnValue("/tmp/test-store.json"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({ sessionsDir: "/tmp" }),
  resolveSessionFilePathCore: vi.fn((sessionId: string) => `/tmp/${sessionId}.jsonl`),
}));
vi.mock("../../config/sessions/reset-policy.js", () => ({
  evaluateSessionFreshness: vi.fn().mockReturnValue({ fresh: true }),
  resolveSessionResetPolicy: vi.fn().mockReturnValue({ mode: "idle", idleMinutes: 60 }),
}));

import { evaluateSessionFreshness } from "../../config/sessions/reset-policy.js";
import { resolveCronSession } from "./session.js";

const NOW_MS = 1_737_600_000_000;
type MockSessionStoreEntry = Partial<SessionEntry> & {
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

function resolveWithStoredEntry(params?: {
  sessionKey?: string;
  sourceSessionKey?: string;
  entry?: MockSessionStoreEntry;
  targetEntry?: SessionEntry;
  forceNew?: boolean;
  fresh?: boolean;
  exactRunSession?: boolean;
}) {
  const sessionKey = params?.sessionKey ?? "webhook:stable-key";
  const sourceSessionKey = params?.sourceSessionKey;
  const store: Record<string, SessionEntry> = params?.entry
    ? {
        [sourceSessionKey ?? sessionKey]: normalizeLegacySessionEntryDelivery(
          params.entry as SessionEntry,
        ),
      }
    : {};
  if (params?.targetEntry) {
    store[sessionKey] = params.targetEntry;
  }
  vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: params?.fresh ?? true });
  const result = resolveCronSession({
    cfg: {},
    sessionKey,
    sourceSessionKey,
    agentId: "main",
    nowMs: NOW_MS,
    forceNew: params?.forceNew,
    exactRunSession: params?.exactRunSession,
    store,
    lifecycleTimestamps: {},
  });
  return {
    ...result,
    sessionEntry: {
      ...result.sessionEntry,
      ...projectSessionDeliveryFields(result.sessionEntry.delivery),
    },
  };
}

const delivery = {
  lastChannel: "slack",
  lastTo: "channel:C0XXXXXXXXX",
  lastThreadId: "1737500000.123456",
  deliveryContext: { channel: "slack", to: "channel:C0XXXXXXXXX", threadId: "1737500000.123456" },
};
const boundContext = {
  spawnedBy: "agent:main:parent",
  spawnedCwd: "/repo/task",
  spawnedWorkspaceDir: "/repo/task",
  sessionRoot: "/repo/task",
  permissionMode: "read-only",
  sandboxMode: "off",
  inheritedToolPolicyVersion: 1,
  inheritedToolAllow: ["read"],
  inheritedToolDeny: ["exec"],
  spawnDepth: 2,
  subagentRole: "leaf",
  subagentControlScope: "none",
  worktree: { id: "worktree-1", branch: "task", repoRoot: "/repo" },
  projectId: "project",
} satisfies Partial<SessionEntry>;

function expectNoDelivery(entry: ReturnType<typeof resolveWithStoredEntry>["sessionEntry"]) {
  for (const field of [
    "lastChannel",
    "lastTo",
    "lastAccountId",
    "lastThreadId",
    "deliveryContext",
  ] as const) {
    expect(entry[field]).toBeUndefined();
  }
}

describe("resolveCronSession", () => {
  // Spawned children and memory-audience leases bind to the parent's exact
  // revision, so a run that reuses an incarnation in place must not rotate it.
  it.each([
    { name: "fresh in-place reuse", keeps: true },
    { name: "exact-run reuse", exactRunSession: true, keeps: false },
  ])("mints a lifecycle revision only for a new run generation ($name)", ({ keeps, ...params }) => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:dashboard:chat",
      ...params,
      entry: {
        sessionId: "existing-session",
        updatedAt: NOW_MS - 1_000,
        lifecycleRevision: "existing-revision",
        systemSent: true,
      },
    });
    expect(result.sessionEntry.lifecycleRevision).toBe(result.lifecycleRevision);
    if (keeps) {
      expect(result.lifecycleRevision).toBe("existing-revision");
    } else {
      expect(result.lifecycleRevision).not.toBe("existing-revision");
      expect(result.lifecycleRevision).toEqual(expect.any(String));
    }
  });

  it.each([
    {
      sessionKey: "agent:main:main",
      forceNew: true,
      initializing: false,
      error: "is archived. Restore it before starting new work.",
    },
    {
      sessionKey: "agent:main:cron:initializing",
      forceNew: true,
      initializing: true,
      error: "is still initializing. Retry after initialization completes.",
    },
    {
      sessionKey: "agent:main:cron:archived",
      forceNew: false,
      initializing: false,
      error: "is archived. Restore it before starting new work.",
    },
  ])(
    "blocks $sessionKey (forced=$forceNew, initializing=$initializing)",
    ({ sessionKey, forceNew, initializing, error }) => {
      expect(() =>
        resolveWithStoredEntry({
          sessionKey,
          forceNew,
          entry: {
            sessionId: "blocked-session",
            updatedAt: NOW_MS - 1_000,
            archivedAt: NOW_MS,
            ...(initializing ? { initializationPending: true as const } : {}),
          },
        }),
      ).toThrow(`Session "${sessionKey}" ${error}`);
    },
  );

  it.each([
    { forceNew: false, existingTarget: false },
    { forceNew: true, existingTarget: true },
  ])(
    "keeps usage with its target (forced=$forceNew, existing=$existingTarget)",
    ({ forceNew, existingTarget }) => {
      const sessionKey = "agent:main:cron:target";
      const sourceSessionKey = "agent:main:chat";
      const result = resolveWithStoredEntry({
        sessionKey,
        sourceSessionKey,
        forceNew,
        entry: {
          sessionId: "source-last",
          lifecycleRevision: "source-revision",
          updatedAt: NOW_MS,
          usageFamilyKey: sourceSessionKey,
          usageFamilySessionIds: ["source-first", "source-last"],
        },
        targetEntry: existingTarget
          ? {
              sessionId: "target-last",
              updatedAt: NOW_MS,
              usageFamilySessionIds: ["target-first", "target-last"],
            }
          : undefined,
      });
      expect(result.sessionEntry.usageFamilyKey).toBe(existingTarget ? sessionKey : undefined);
      expect(result.sessionEntry.usageFamilySessionIds).toEqual(
        existingTarget ? ["target-first", "target-last", result.sessionEntry.sessionId] : undefined,
      );
      expect(result.sessionEntry.createdActor).toBeUndefined();
      expect(result.lifecycleRevision).not.toBe("source-revision");
    },
  );

  it("rolls forced runs to a new identity, preserving user preferences and clearing prior routing and workspace", () => {
    const preferences = {
      pinnedAt: NOW_MS - 500,
      sidebarRoot: true,
      modelOverride: "claude-sonnet-4-6",
      providerOverride: "anthropic",
      modelOverrideSource: "user" as const,
      agentRuntimeOverride: "openclaw",
      authProfileOverride: "work-profile",
      authProfileOverrideSource: "user" as const,
      authProfileOverrideCompactionCount: 3,
    };
    const result = resolveWithStoredEntry({
      forceNew: true,
      entry: {
        sessionId: "old-session",
        lifecycleRevision: "old-revision",
        updatedAt: NOW_MS - 1_000,
        systemSent: true,
        sessionFile: "/tmp/stale-session.jsonl",
        agentHarnessId: "codex",
        ...boundContext,
        ...delivery,
        lastAccountId: "acct-123",
        ...preferences,
      },
    });
    expect(result.sessionEntry.sessionId).not.toBe("old-session");
    expect(result.isNewSession).toBe(true);
    expect(result.lifecycleRevision).not.toBe("old-revision");
    expect(result.previousSessionId).toBe("old-session");
    expect(result.systemSent).toBe(false);
    expect(result.sessionEntry).toMatchObject(preferences);
    expect(result.sessionEntry.sessionFile).toBeUndefined();
    expect(result.sessionEntry.agentHarnessId).toBeUndefined();
    expectNoDelivery(result.sessionEntry);
    for (const field of Object.keys(boundContext)) {
      expect(result.sessionEntry).not.toHaveProperty(field);
    }
  });

  it("sanitizes the configured default during forced rollover", () => {
    const result = resolveWithStoredEntry({
      forceNew: true,
      entry: {
        sessionId: "old-session",
        updatedAt: NOW_MS - 1_000,
        modelOverrideSource: "default",
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-5.4",
      },
    });
    expect(result.isNewSession).toBe(true);
    expect(result.sessionEntry.modelOverrideSource).toBe("default");
    expect(result.sessionEntry.modelOverride).toBeUndefined();
  });

  it("preserves legacy user auth during forced rollover without a compaction count", () => {
    const result = resolveWithStoredEntry({
      forceNew: true,
      entry: {
        sessionId: "old-session",
        updatedAt: NOW_MS - 1_000,
        authProfileOverride: "work-profile",
      },
    });
    expect(result.isNewSession).toBe(true);
    expect(result.sessionEntry).toMatchObject({
      authProfileOverride: "work-profile",
      authProfileOverrideSource: "user",
    });
    expect(result.sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("resets a stale persistent session in place, retaining workspace restrictions but clearing delivery and runtime handles", () => {
    const ambient = {
      ...boundContext,
      elevatedLevel: "full" as const,
      sendPolicy: "deny" as const,
      queueMode: "collect" as const,
    };
    const result = resolveWithStoredEntry({
      fresh: false,
      entry: {
        sessionId: "old-session",
        lifecycleRevision: "old-revision",
        updatedAt: NOW_MS - 86_400_000,
        systemSent: true,
        sessionFile: "/tmp/legacy-session.jsonl",
        modelOverride: "gpt-4.1-mini",
        providerOverride: "openai",
        agentHarnessId: "codex",
        claudeCliSessionId: "native-before-boundary",
        compactionCount: 9,
        ...ambient,
        ...delivery,
        channel: "discord",
        origin: { provider: "discord", to: "old-channel" },
      },
    });
    expect(result.sessionEntry.sessionId).toBe("old-session");
    expect(result.isNewSession).toBe(true);
    expect(result.lifecycleRevision).not.toBe("old-revision");
    expect(result.previousSessionId).toBeUndefined();
    expect(result.systemSent).toBe(false);
    expect(result.sessionEntry).toMatchObject({
      ...ambient,
      modelOverride: "gpt-4.1-mini",
      providerOverride: "openai",
      compactionCount: 0,
    });
    expect(result.sessionEntry.agentHarnessId).toBeUndefined();
    expect(result.sessionEntry.claudeCliSessionId).toBeUndefined();
    expect(result.sessionEntry).not.toHaveProperty("sessionFile");
    expect(result.resetBoundaryPending).toMatchObject({ reason: "cron-stale" });
    expectNoDelivery(result.sessionEntry);
    expect(result.sessionEntry.channel).toBeUndefined();
    expect(result.sessionEntry.origin).toBeUndefined();
  });
});
