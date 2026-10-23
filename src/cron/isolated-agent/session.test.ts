import { expect, it, vi } from "vitest";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import type { projectSessionDeliveryFields } from "../../utils/delivery-context.shared.js";

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: vi.fn().mockReturnValue("/tmp/test-store.json"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({ sessionsDir: "/tmp" }),
  resolveSessionFilePathCore: vi.fn((sessionId: string) => `/tmp/${sessionId}.jsonl`),
}));
vi.mock("../../config/sessions/reset-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/reset-policy.js")>()),
  evaluateSessionFreshness: vi.fn().mockReturnValue({ fresh: true }),
}));

import { evaluateSessionFreshness } from "../../config/sessions/reset-policy.js";
import { resolveCronSession } from "./session.js";

const NOW_MS = 1_737_600_000_000;
type MockSessionStoreEntry = Partial<
  SessionEntry & ReturnType<typeof projectSessionDeliveryFields>
>;

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
  const store: Record<string, SessionEntry> = {};
  if (params?.entry) {
    store[sourceSessionKey ?? sessionKey] = normalizeLegacySessionEntryDelivery({
      sessionId: "old-session",
      updatedAt: NOW_MS - 1_000,
      ...params.entry,
    });
  }
  if (params?.targetEntry) {
    store[sessionKey] = params.targetEntry;
  }
  vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: params?.fresh ?? true });
  return resolveCronSession({
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
  { forceNew: false, initializing: false },
  { forceNew: false, initializing: true },
  { forceNew: true, initializing: false },
  { forceNew: true, initializing: true },
])(
  "guards archived sessions: forced=$forceNew, initializing=$initializing",
  ({ forceNew, initializing }) => {
    const sessionKey = "agent:main:cron:test";
    const resolve = () =>
      resolveWithStoredEntry({
        sessionKey,
        forceNew,
        entry: {
          sessionId: "archived-session",
          archivedAt: NOW_MS,
          ...(initializing ? { initializationPending: true as const } : {}),
        },
      });
    const error = initializing
      ? "is still initializing. Retry after initialization completes."
      : "is archived. Restore it before starting new work.";
    expect(resolve).toThrow(`Session "${sessionKey}" ${error}`);
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

it.each([true, false])("resets routing and runtime handles (forced=$0)", (forceNew) => {
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
  const ambient = {
    ...boundContext,
    elevatedLevel: "full",
    sendPolicy: "deny",
    queueMode: "collect",
  } as const;
  const stalePreferences = { modelOverride: "gpt-4.1-mini", providerOverride: "openai" };
  const result = resolveWithStoredEntry({
    forceNew,
    fresh: forceNew,
    entry: {
      lifecycleRevision: "old-revision",
      updatedAt: NOW_MS - (forceNew ? 1_000 : 86_400_000),
      systemSent: true,
      sessionFile: forceNew ? "/tmp/stale-session.jsonl" : "/tmp/legacy-session.jsonl",
      agentHarnessId: "codex",
      ...boundContext,
      ...delivery,
      ...(forceNew
        ? { lastAccountId: "acct-123", ...preferences }
        : {
            ...ambient,
            ...stalePreferences,
            claudeCliSessionId: "native-before-boundary",
            compactionCount: 9,
            channel: "discord",
            origin: { provider: "discord", to: "old-channel" },
          }),
    },
  });
  expect(result).toMatchObject({
    isNewSession: true,
    systemSent: false,
    previousSessionId: forceNew ? "old-session" : undefined,
  });
  expect(result.lifecycleRevision).not.toBe("old-revision");
  expect(result.sessionEntry.agentHarnessId).toBeUndefined();
  expect(result.sessionEntry.delivery).toBeUndefined();
  expect(result.sessionEntry).not.toHaveProperty("channel");
  expect(result.sessionEntry).not.toHaveProperty("origin");
  if (forceNew) {
    expect(result.sessionEntry.sessionId).not.toBe("old-session");
    expect(result.sessionEntry).toMatchObject(preferences);
    expect(result.sessionEntry.sessionFile).toBeUndefined();
    for (const field of Object.keys(boundContext)) {
      expect(result.sessionEntry).not.toHaveProperty(field);
    }
  } else {
    expect(result.sessionEntry).toMatchObject({
      sessionId: "old-session",
      ...ambient,
      ...stalePreferences,
      compactionCount: 0,
    });
    expect(result.sessionEntry.claudeCliSessionId).toBeUndefined();
    expect(result.sessionEntry).not.toHaveProperty("sessionFile");
    expect(result.resetBoundaryPending).toMatchObject({ reason: "cron-stale" });
  }
});

it("keeps a provider-owned CLI session with the default reset policy", () => {
  const startedAt = NOW_MS - 86_400_000;
  const result = resolveWithStoredEntry({
    sessionKey: "agent:main:cron:daily-job",
    fresh: false,
    entry: {
      sessionId: "old-session-id",
      updatedAt: startedAt,
      sessionStartedAt: startedAt,
      lastInteractionAt: startedAt,
      modelProvider: "claude-cli",
      cliSessionBindings: { "claude-cli": { sessionId: "cli-conversation-xyz" } },
    },
  });
  expect(result).toMatchObject({
    isNewSession: false,
    sessionEntry: { sessionId: "old-session-id" },
  });
  expect(getCliSessionBinding(result.sessionEntry, "claude-cli")).toEqual({
    sessionId: "cli-conversation-xyz",
  });
});

it.each([
  {
    name: "configured model default",
    entry: {
      modelOverrideSource: "default",
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-5.4",
    },
    expected: { modelOverrideSource: "default" },
    cleared: "modelOverride",
  },
  {
    name: "legacy user auth",
    entry: { authProfileOverride: "work-profile" },
    expected: { authProfileOverride: "work-profile", authProfileOverrideSource: "user" },
    cleared: "authProfileOverrideCompactionCount",
  },
] satisfies {
  name: string;
  entry: MockSessionStoreEntry;
  expected: Partial<SessionEntry>;
  cleared: keyof SessionEntry;
}[])("preserves $name policy during forced rollover", ({ entry, expected, cleared }) => {
  const result = resolveWithStoredEntry({
    forceNew: true,
    entry,
  });
  expect(result.isNewSession).toBe(true);
  expect(result.sessionEntry).toMatchObject(expected);
  expect(result.sessionEntry[cleared]).toBeUndefined();
});
