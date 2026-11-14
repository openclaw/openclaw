import { expect, it, vi } from "vitest";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import { expectObjectFields } from "../../test-utils/mock-call-assertions.js";
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
  inferenceCaptured?: boolean;
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
    inferenceCaptured: params?.inferenceCaptured,
    store,
    lifecycleTimestamps: {},
  });
}

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

it.each([
  { name: "new session", existing: false, keeps: false },
  { name: "in-place reuse", existing: true, keeps: true },
  { name: "exact-run reuse", existing: true, exactRunSession: true, keeps: false },
])(
  "preserves recency and mints only new run revisions ($name)",
  ({ keeps, existing, ...params }) => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:dashboard:chat",
      ...params,
      entry: existing ? { lifecycleRevision: "existing-revision", systemSent: true } : undefined,
    });
    expect(result.sessionEntry.updatedAt).toBe(existing ? NOW_MS - 1_000 : NOW_MS);
    expect(result.sessionEntry.lifecycleRevision).toBe(result.lifecycleRevision);
    if (keeps) {
      expect(result.lifecycleRevision).toBe("existing-revision");
    } else {
      expect(result.lifecycleRevision).not.toBe("existing-revision");
      expect(result.lifecycleRevision).toEqual(expect.any(String));
    }
  },
);

it.each([false, true])(
  "guards archived sessions before forced rollover (initializing=%s)",
  (initializing) => {
    const sessionKey = "agent:main:cron:test";
    const resolve = () =>
      resolveWithStoredEntry({
        sessionKey,
        forceNew: true,
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
      lastChannel: "slack",
      lastTo: "channel:C0XXXXXXXXX",
      lastThreadId: "1737500000.123456",
      deliveryContext: {
        channel: "slack",
        to: "channel:C0XXXXXXXXX",
        threadId: "1737500000.123456",
      },
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
  expectObjectFields(result.sessionEntry, { agentHarnessId: undefined, delivery: undefined });
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
  const result = resolveWithStoredEntry({
    sessionKey: "agent:main:cron:daily-job",
    fresh: false,
    entry: {
      sessionId: "old-session-id",
      updatedAt: NOW_MS - 86_400_000,
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
  [
    "configured model default",
    {
      modelOverrideSource: "default",
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-5.4",
    },
    { modelOverrideSource: "default", modelOverride: undefined },
  ],
  [
    "legacy user auth",
    { authProfileOverride: "work-profile" },
    {
      authProfileOverride: "work-profile",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    },
  ],
] satisfies [string, MockSessionStoreEntry, Partial<SessionEntry>][])(
  "preserves %s policy during forced rollover",
  (_name, entry, expected) => {
    const result = resolveWithStoredEntry({ forceNew: true, entry });
    expect(result.isNewSession).toBe(true);
    expectObjectFields(result.sessionEntry, expected);
  },
);

it.each([
  { name: "a captured job copying its conversation", source: true, captured: true, carries: false },
  {
    name: "an uncaptured job copying its conversation",
    source: true,
    captured: false,
    carries: true,
  },
  { name: "a captured job rolling its own row", source: false, captured: true, carries: true },
])(
  "seeds inference selection only when it is not captured ($name)",
  ({ source, captured, carries }) => {
    const selection = {
      modelOverride: "gpt-4.1",
      providerOverride: "openai",
      modelOverrideSource: "user" as const,
      agentRuntimeOverride: "codex",
      authProfileOverride: "work-profile",
      authProfileOverrideSource: "user" as const,
    };
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:job-1",
      ...(source ? { sourceSessionKey: "agent:main:dashboard:parent" } : {}),
      forceNew: true,
      inferenceCaptured: captured,
      entry: { thinkingLevel: "high", ...selection },
    });
    // Preferences other than inference keep following the copied row.
    expect(result.sessionEntry.thinkingLevel).toBe("high");
    if (carries) {
      expect(result.sessionEntry).toMatchObject(selection);
    } else {
      for (const field of Object.keys(selection)) {
        expect(result.sessionEntry).not.toHaveProperty(field);
      }
    }
  },
);
