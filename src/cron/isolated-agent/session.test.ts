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
  it.each([
    {
      name: "selected model",
      modelOverride: "deepseek-v3-4bit-mlx",
      providerOverride: "inferencer",
    },
    { name: "no model selection", modelOverride: undefined, providerOverride: undefined },
  ])(
    "reuses fresh identity, preferences, and delivery with $name",
    ({ modelOverride, providerOverride }) => {
      const entry = {
        sessionId: "existing-session",
        updatedAt: NOW_MS - 1_000,
        lastInteractionAt: NOW_MS - 30 * 60_000,
        systemSent: true,
        modelOverride,
        providerOverride,
        thinkingLevel: "high" as const,
        model: "kimi-code",
        ...delivery,
      };
      const result = resolveWithStoredEntry({ entry });
      expect(result.sessionEntry).toMatchObject({ ...entry, updatedAt: NOW_MS });
      expect(result.isNewSession).toBe(false);
      expect(result.previousSessionId).toBeUndefined();
      expect(result.systemSent).toBe(true);
      expect(result.sessionEntry.deliveryContext).toEqual(delivery.deliveryContext);
    },
  );

  it.each([
    { name: "absent entry", entry: undefined },
    {
      name: "entry without an ID",
      entry: { updatedAt: NOW_MS - 1_000, modelOverride: "some-model" },
    },
  ])("creates a new session and independent lifecycle revision for $name", ({ entry }) => {
    const first = resolveWithStoredEntry({ entry });
    const second = resolveWithStoredEntry({ entry });
    expect(first.isNewSession).toBe(true);
    expect(typeof first.sessionEntry.sessionId).toBe("string");
    expect(first.sessionEntry.sessionId).not.toHaveLength(0);
    expect(first.sessionEntry.modelOverride).toBe(entry?.modelOverride);
    expect(first.sessionEntry.providerOverride).toBeUndefined();
    expect(first.sessionEntry.model).toBeUndefined();
    expect(first.lifecycleRevision).toBe(first.sessionEntry.lifecycleRevision);
    expect(second.lifecycleRevision).toBe(second.sessionEntry.lifecycleRevision);
    expect(first.lifecycleRevision).not.toBe(second.lifecycleRevision);
  });

  // Spawned children and memory-audience leases bind to the parent's exact
  // revision, so a run that reuses an incarnation in place must not rotate it.
  it.each([
    { name: "fresh in-place reuse", keeps: true },
    { name: "exact-run reuse", exactRunSession: true, keeps: false },
    { name: "stale reset", fresh: false, keeps: false },
    { name: "forced rollover", forceNew: true, keeps: false },
    { name: "differing source session", sourceSessionKey: "agent:main:chat", keeps: false },
    { name: "row without a revision", unrevisioned: true, keeps: false },
  ])(
    "mints a lifecycle revision only for a new run generation ($name)",
    ({ keeps, unrevisioned, ...params }) => {
      const result = resolveWithStoredEntry({
        sessionKey: "agent:main:dashboard:chat",
        ...params,
        entry: {
          sessionId: "existing-session",
          updatedAt: NOW_MS - 1_000,
          ...(unrevisioned ? {} : { lifecycleRevision: "existing-revision" }),
        },
      });
      expect(result.sessionEntry.lifecycleRevision).toBe(result.lifecycleRevision);
      if (keeps) {
        expect(result.lifecycleRevision).toBe("existing-revision");
      } else {
        expect(result.lifecycleRevision).not.toBe("existing-revision");
        expect(result.lifecycleRevision).toEqual(expect.any(String));
      }
    },
  );

  it.each([
    {
      sessionKey: "agent:main:main",
      forceNew: true,
      heartbeat: false,
      initializing: false,
      error: "is archived. Restore it before starting new work.",
    },
    {
      sessionKey: "agent:main:main:heartbeat",
      forceNew: true,
      heartbeat: true,
      initializing: true,
      error: "is still initializing. Retry after initialization completes.",
    },
    {
      sessionKey: "agent:main:main:heartbeat",
      forceNew: false,
      heartbeat: true,
      initializing: false,
      error: "is archived. Restore it before starting new work.",
    },
  ])(
    "blocks $sessionKey (forced=$forceNew, initializing=$initializing)",
    ({ sessionKey, forceNew, heartbeat, initializing, error }) => {
      expect(() =>
        resolveWithStoredEntry({
          sessionKey,
          forceNew,
          entry: {
            sessionId: "blocked-session",
            updatedAt: NOW_MS - 1_000,
            archivedAt: NOW_MS,
            ...(heartbeat ? { heartbeatIsolatedBaseSessionKey: "agent:main:main" } : {}),
            ...(initializing ? { initializationPending: true as const } : {}),
          },
        }),
      ).toThrow(`Session "${sessionKey}" ${error}`);
    },
  );

  it("rolls an archived isolated heartbeat session into a fresh run", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:main:heartbeat",
      forceNew: true,
      entry: {
        sessionId: "archived-heartbeat-session",
        updatedAt: NOW_MS - 1_000,
        archivedAt: NOW_MS,
        heartbeatIsolatedBaseSessionKey: "agent:main:main",
      },
    });
    expect(result.isNewSession).toBe(true);
    expect(result.previousSessionId).toBe("archived-heartbeat-session");
    expect(result.sessionEntry.sessionId).not.toBe("archived-heartbeat-session");
    expect(result.sessionEntry.archivedAt).toBeUndefined();
    expect(result.sessionEntry.heartbeatIsolatedBaseSessionKey).toBeUndefined();
  });

  it.each([
    { name: "forced rollover", fresh: true, forceNew: true },
    { name: "stale reset", fresh: false, forceNew: false },
  ])("preserves usage history and creation provenance across $name", ({ fresh, forceNew }) => {
    const sessionKey = "agent:main:cron:usage-history";
    const provenance = {
      createdAt: NOW_MS - 86_400_000,
      createdVia: "cron" as const,
      createdActor: {
        type: "human" as const,
        source: "profile" as const,
        id: "profile-cron-creator",
      },
      sandbox: "required" as const,
    };
    const entry = {
      sessionId: "previous-run",
      updatedAt: NOW_MS - 1_000,
      usageFamilyKey: sessionKey,
      usageFamilySessionIds: ["first-run", "previous-run"],
      ...provenance,
    };
    const result = resolveWithStoredEntry({ sessionKey, entry, fresh, forceNew });
    expect(result.isNewSession).toBe(true);
    expect(result.sessionEntry).toMatchObject(provenance);
    expect(result.sessionEntry.usageFamilyKey).toBe(sessionKey);
    expect(result.sessionEntry.usageFamilySessionIds).toEqual([
      ...entry.usageFamilySessionIds,
      ...(forceNew ? [result.sessionEntry.sessionId] : []),
    ]);
    expect(result.sessionEntry.createdActor).toEqual(entry.createdActor);
    expect(entry.usageFamilySessionIds).toEqual(["first-run", "previous-run"]);
  });

  it.each([
    { forceNew: true, existingTarget: false },
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
    },
  );

  it("rolls forced runs to a new identity, preserving user preferences and clearing prior routing and workspace", () => {
    const preferences = {
      pinnedAt: NOW_MS - 500,
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

  it.each<{
    name: string;
    entry: Partial<SessionEntry>;
    retained: Partial<SessionEntry>;
    cleared: (keyof SessionEntry)[];
  }>([
    {
      name: "configured default",
      entry: {
        modelOverrideSource: "default",
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-5.4",
      },
      retained: { modelOverrideSource: "default" },
      cleared: ["modelOverride"],
    },
    {
      name: "standalone runtime",
      entry: { agentRuntimeOverride: "openclaw", agentHarnessId: "codex" },
      retained: {},
      cleared: ["agentRuntimeOverride", "agentHarnessId"],
    },
    {
      name: "legacy user auth",
      entry: { authProfileOverride: "work-profile" },
      retained: { authProfileOverride: "work-profile", authProfileOverrideSource: "user" },
      cleared: ["authProfileOverrideCompactionCount"],
    },
  ])("sanitizes $name during forced rollover", ({ entry, retained, cleared }) => {
    const result = resolveWithStoredEntry({
      forceNew: true,
      entry: { sessionId: "old-session", updatedAt: NOW_MS - 1_000, ...entry },
    });
    expect(result.isNewSession).toBe(true);
    expect(result.sessionEntry).toMatchObject(retained);
    for (const field of cleared) {
      expect(result.sessionEntry[field]).toBeUndefined();
    }
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

  it("clears stale run-scoped state when forceNew rolls to a fresh session", () => {
    const discarded = {
      status: "done",
      startedAt: NOW_MS - 10_000,
      endedAt: NOW_MS - 1_000,
      runtimeMs: 9_000,
      lastHeartbeatText: "old heartbeat",
      lastHeartbeatSentAt: NOW_MS - 1_000,
      heartbeatIsolatedBaseSessionKey: "agent:main:cron:old",
      model: "claude-opus-4-6",
      modelProvider: "anthropic",
      agentHarnessId: "claude-cli",
      agentRuntimeOverride: "claude-cli",
      cliSessionIds: { anthropic: "old-cli-session" },
      cliSessionBindings: {},
      claudeCliSessionId: "old-claude-session",
      liveModelSwitchPending: true,
      fallbackNotice: {
        kind: "active",
        selectedModel: "anthropic/claude-opus-4-6",
        activeModel: "anthropic/claude-sonnet-4-6",
        reason: "rate limit",
      },
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      totalTokensFresh: true,
      estimatedCostUsd: 0.01,
      execHost: "gateway",
      execNode: "node-1",
      cacheRead: 4,
      cacheWrite: 5,
      contextTokens: 200_000,
      contextTokensSource: "runtime",
      compactionCount: 9,
      memoryFlush: { kind: "succeeded", compactionCount: 9 },
      abortCutoffMessageSid: "old-message",
      spawnedBy: "agent:main:session:parent",
      skillsSnapshot: {
        prompt: "old skills",
        skills: [{ name: "stale-skill" }],
      },
      systemPromptReport: {
        source: "run",
        generatedAt: NOW_MS,
        systemPrompt: {
          chars: 1,
          projectContextChars: 0,
          nonProjectContextChars: 1,
        },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
      pluginDebugEntries: [{ pluginId: "test", lines: ["old"] }],
      elevatedLevel: "full",
      sendPolicy: "deny",
      groupActivation: "always",
      groupActivationNeedsSystemIntro: true,
      queueMode: "interrupt",
      queueDebounceMs: 500,
      queueCap: 25,
      queueDrop: "old",
      channel: "telegram",
      groupId: "group-1",
      subject: "old subject",
      groupChannel: "ops",
      space: "team",
      origin: {
        provider: "telegram",
        to: "old-chat",
      },
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "old-acp",
        mode: "persistent",
        state: "idle",
        lastActivityAt: NOW_MS - 1_000,
      },
      authProfileOverride: "auto-auth",
      authProfileOverrideCompactionCount: 2,
      modelOverride: "auto-model",
      providerOverride: "anthropic",
      modelOverrideSource: "auto",
    } satisfies MockSessionStoreEntry;
    const result = resolveWithStoredEntry({
      entry: { sessionId: "old-session", updatedAt: NOW_MS - 1_000, ...discarded },
      forceNew: true,
    });
    expect(result.isNewSession).toBe(true);
    for (const field of [...Object.keys(discarded), "authProfileOverrideSource"]) {
      expect(Reflect.get(result.sessionEntry, field), field).toBeUndefined();
    }
  });
});
