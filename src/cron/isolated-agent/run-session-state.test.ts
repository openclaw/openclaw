import crypto from "node:crypto";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import { projectCronSessionEntry } from "../../config/sessions/session-entry-patch-operation.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  adoptCronRunSessionMetadata,
  CronSessionLifecycleClaimError,
  createCronRunContinuationSession,
  createPersistCronSessionEntry,
  syncCronSessionLiveSelection,
  type CronSessionRowWriter,
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

function makeCronSession(
  entry: Partial<SessionEntry> = {},
  storePath = "/tmp/sessions.json",
  overrides: Partial<MutableCronSession> = {},
): MutableCronSession {
  return {
    storePath,
    store: {},
    sessionEntry: makeSessionEntry(entry),
    systemSent: true,
    isNewSession: true,
    previousSessionId: undefined,
    ...overrides,
  } as MutableCronSession;
}

function makePersist(
  cronSession: MutableCronSession,
  agentSessionKey: string,
  persistSessionEntry: CronSessionRowWriter,
) {
  return createPersistCronSessionEntry({
    cronSession,
    agentSessionKey,
    persistSessionEntry,
    workspaceDir: "/tmp/workspace",
  });
}

/** In-memory adapter for the same closed operation used by the session writer. */
function makeGuardedPersist(
  cronSession: MutableCronSession,
  sessionKey: string,
  persistedStore: Record<string, SessionEntry>,
) {
  return makePersist(cronSession, sessionKey, async (params) => {
    const entry = projectCronSessionEntry(params.operation, persistedStore[params.sessionKey]);
    persistedStore[params.sessionKey] = entry;
    return entry;
  });
}

describe("syncCronSessionLiveSelection", () => {
  it("clears model-derived state when only the agent runtime changes", () => {
    const entry = makeSessionEntry({
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntimeOverride: "openclaw",
      contextTokens: 272_000,
      contextTokensSource: "runtime",
      contextBudgetStatus: {} as NonNullable<SessionEntry["contextBudgetStatus"]>,
    });

    syncCronSessionLiveSelection({
      entry,
      liveSelection: {
        provider: "openai",
        model: "gpt-5.6-luna",
        agentRuntimeOverride: "codex",
      },
    });

    expect(entry.agentRuntimeOverride).toBe("codex");
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.contextTokensSource).toBeUndefined();
    expect(entry.contextBudgetStatus).toBeUndefined();
  });

  it("stamps a source-less live profile as a user pin", () => {
    const entry = makeSessionEntry({
      compactionCount: 4,
      authProfileOverrideCompactionCount: 2,
    });

    syncCronSessionLiveSelection({
      entry,
      liveSelection: {
        provider: "openai",
        model: "gpt-5.4",
        authProfileId: "openai:work",
      },
    });

    expect(entry.authProfileOverride).toBe("openai:work");
    expect(entry.authProfileOverrideSource).toBe("user");
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("retains legacy automatic provenance for the same live profile", () => {
    const entry = makeSessionEntry({
      compactionCount: 4,
      authProfileOverride: "openai:fallback",
      authProfileOverrideCompactionCount: 2,
    });

    syncCronSessionLiveSelection({
      entry,
      liveSelection: {
        provider: "openai",
        model: "gpt-5.4",
        authProfileId: "openai:fallback",
      },
    });

    expect(entry.authProfileOverrideSource).toBe("auto");
    expect(entry.authProfileOverrideCompactionCount).toBe(4);
  });
});

describe("createPersistCronSessionEntry", () => {
  // Regression: an empty reset window used process.cwd() instead of the cron workspace.
  it("records the cron workspace in the header when a stale reset lands on an empty window", async () => {
    const dir = sessionDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const agentSessionKey = "agent:main:cron:stale-empty-window";
    const lifecycleRevision = crypto.randomUUID();
    const previousEntry: SessionEntry = {
      sessionId: "cron-empty-window",
      updatedAt: 10,
      lifecycleRevision,
    };
    await replaceSessionEntry({ sessionKey: agentSessionKey, storePath }, previousEntry);
    const cronSession = makeCronSession(
      { sessionId: "cron-next-window", lifecycleRevision },
      storePath,
      {
        initialSessionEntry: previousEntry,
        lifecycleRevision,
        resetBoundaryPending: {
          reason: "cron-stale",
          sessionFile: `sqlite:main:cron-empty-window:${storePath}`,
        },
      },
    );

    // Mirrors the run-prepare producer: a pending boundary goes through the
    // batched lifecycle mutation with the run workspace attached.
    await createPersistCronSessionEntry({
      cronSession,
      agentSessionKey,
      workspaceDir: "/tmp/cron-stale-workspace",
      persistSessionEntry: async ({
        sessionKey,
        storePath: rowStorePath,
        resetBoundary,
        operation,
      }) => {
        if (!resetBoundary) {
          throw new Error("expected a pending cron reset boundary");
        }
        let entry = operation.next;
        await applySessionEntryLifecycleMutation({
          activeSessionKey: sessionKey,
          agentId: "main",
          storePath: rowStorePath,
          upserts: [
            {
              sessionKey,
              resetBoundary,
              buildEntry: ({ currentEntry }) =>
                (entry = projectCronSessionEntry(operation, currentEntry)),
            },
          ],
          skipMaintenance: true,
        });
        return entry;
      },
    })();

    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    if (!target.path) {
      throw new Error("expected SQLite database path");
    }
    const database = openOpenClawAgentDatabase({
      agentId: target.agentId ?? "main",
      path: target.path,
    });
    try {
      const events = readTranscriptEventRows(database, "cron-empty-window").map(
        (row) => JSON.parse(row.eventJson) as { type?: unknown; version?: unknown; cwd?: unknown },
      );
      expect(events).toMatchObject([
        { type: "session", version: CURRENT_SESSION_VERSION, cwd: "/tmp/cron-stale-workspace" },
        { type: "reset" },
      ]);
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
    expect(cronSession.store[agentSessionKey]?.sessionId).toBe("cron-next-window");
    expect(cronSession.resetBoundaryPending).toBeUndefined();
  });

  it("keeps a pending reset boundary when the guarded row commit fails", async () => {
    const cronSession = makeCronSession(undefined, undefined, {
      resetBoundaryPending: {
        reason: "cron-stale" as const,
        sessionFile: "sqlite:main:run-session-id:/tmp/sessions.json",
      },
    });
    const persist = makePersist(
      cronSession,
      "agent:main:cron:job",
      vi.fn(async () => {
        throw new Error("write failed");
      }),
    );

    await expect(persist()).rejects.toThrow("write failed");

    expect(cronSession.resetBoundaryPending).toBeDefined();
  });

  it("owns an exact hidden continuation row without colliding with another run", async () => {
    const runSessionKey = "agent:main:cron:job:run:run-session-id";
    const lifecycleRevision = crypto.randomUUID();
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const scope = { storePath, sessionKey: runSessionKey };
    const read = () => loadSessionEntry(scope);
    const cronSession = makeCronSession(
      {
        lifecycleRevision,
        modelProvider: "claude-cli",
        model: "claude-opus-4-8",
        // Node-local lineage on the base row must not leak onto the :run: node.
        previousSessionId: "base-prior-generation",
        forkSource: { sessionKey: "agent:main:other", sessionId: "other-generation" },
      },
      storePath,
      { lifecycleRevision },
    );
    const toolPolicy = {
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:discord:group:ops",
        ownerAccountId: "work",
      },
      scheduledToolCallerOrigin: { kind: "local" },
      toolsAllowExecTarget: { version: 1, host: "gateway", ask: "always" },
      toolsAllowExecTargetRequirement: {
        version: 1,
        target: { version: 1, host: "gateway", ask: "always" },
        grantIndex: 1,
      },
    } as const;
    const continuation = createCronRunContinuationSession({
      cronSession,
      runSessionKey,
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      thinkingLevel: "high",
      toolsAllow: ["image_generate", "exec", "write"],
      toolsAllowIsDefault: true,
      ...structuredClone(toolPolicy),
    });

    await continuation.initialize();
    await continuation.sync();
    let persisted = read();
    expect(persisted?.previousSessionId).toBeUndefined();
    expect(persisted?.forkSource).toBeUndefined();
    expect(persisted?.cronRunContinuation).toEqual(expect.objectContaining(toolPolicy));
    expect(persisted).toMatchObject({
      createdVia: "cron",
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      createdAt: expect.any(Number),
      sessionId: "run-session-id",
      modelProvider: "claude-cli",
      model: "claude-opus-4-8",
      thinkingLevel: "high",
      cronRunContinuation: {
        lifecycleRevision,
        phase: "running",
        toolsAllow: ["image_generate", "write"],
        toolsAllowIsDefault: true,
      },
    });

    const cliBinding = { sessionId: "native-claude-session", forceReuse: true };
    cronSession.sessionEntry.cliSessionBindings = { "claude-cli": cliBinding };
    await continuation.sync(undefined, { cliExecutionProvider: "claude-cli" });
    persisted = read();
    expect(persisted?.cronRunContinuation?.cliExecutionProvider).toBe("claude-cli");
    expect(persisted?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "native-claude-session",
      forceReuse: true,
    });
    await continuation.sync(undefined, { cliExecutionProvider: "claude-cli" });

    cliBinding.sessionId = "updated-native-session";
    await expect(
      continuation.sync(() => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    await continuation.sync();
    persisted = read();
    expect(persisted?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe("updated-native-session");

    await continuation.sync(undefined, {});
    persisted = read();
    expect(persisted?.cronRunContinuation?.cliExecutionProvider).toBeUndefined();
    expect(persisted?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe("updated-native-session");

    const current = persisted!;
    await replaceSessionEntry(scope, { ...current, label: "owner metadata" });
    delete cronSession.sessionEntry.cliSessionBindings;
    await continuation.sync();
    persisted = read();
    expect(persisted?.label).toBe("owner metadata");
    expect(persisted?.cliSessionBindings).toBeUndefined();

    await continuation.seal({ basePersisted: true });
    persisted = read();
    expect(persisted?.cronRunContinuation).toMatchObject({
      phase: "ready",
      basePersisted: true,
    });
    cronSession.sessionEntry.model = "newer-owner-model";
    await expect(continuation.sync()).rejects.toBeInstanceOf(CronSessionLifecycleClaimError);
    expect(read()?.model).toBe("claude-opus-4-8");

    const handedOff = makeSessionEntry({
      sessionId: "continued-session-id",
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      cronRunContinuation: {
        lifecycleRevision,
        phase: "continuing",
        ownerRunId: "completion-run",
      },
    });
    await replaceSessionEntry(scope, structuredClone(handedOff));
    await expect(continuation.sync()).rejects.toBeInstanceOf(CronSessionLifecycleClaimError);
    await continuation.seal();
    expect(read()).toMatchObject(handedOff);
  });

  it("retains the required base creator when a continuation is created after job ownership changes", async () => {
    const creator = { type: "human", source: "profile", id: "profile-original-creator" } as const;
    const lifecycleRevision = crypto.randomUUID();
    const cronSession = makeCronSession(
      {
        createdVia: "cron",
        createdActor: creator,
        sandbox: "required",
        lifecycleRevision,
      },
      path.join(sessionDirs.make(), "sessions.json"),
    );
    cronSession.lifecycleRevision = lifecycleRevision;
    const runSessionKey = "agent:main:cron:job:run:required";
    const continuation = createCronRunContinuationSession({
      cronSession,
      runSessionKey,
      createdActor: { type: "human", source: "profile", id: "profile-current-job-owner" },
    });
    await continuation.initialize();
    await continuation.sync();
    expect(
      loadSessionEntry({ storePath: cronSession.storePath, sessionKey: runSessionKey }),
    ).toMatchObject({
      createdActor: creator,
      sandbox: "required",
    });
  });

  it("does not overwrite a continuation handed to another owner", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const runSessionKey = "agent:main:cron:job:run:handoff";
    const lifecycleRevision = crypto.randomUUID();
    const cronSession = makeCronSession({ lifecycleRevision }, storePath);
    cronSession.lifecycleRevision = lifecycleRevision;
    const continuation = createCronRunContinuationSession({ cronSession, runSessionKey });
    await continuation.initialize();
    const scope = { storePath, sessionKey: runSessionKey };
    const ready = makeSessionEntry({
      label: "already sealed",
      cronRunContinuation: { lifecycleRevision, phase: "ready", basePersisted: true },
    });
    await replaceSessionEntry(scope, ready);
    await continuation.seal();
    expect(loadSessionEntry(scope)).toMatchObject(ready);
    const staleOwner = createCronRunContinuationSession({ cronSession, runSessionKey });
    const handedOff = makeSessionEntry({
      label: "detached owner",
      cronRunContinuation: { lifecycleRevision, phase: "continuing", ownerRunId: "detached" },
    });
    await replaceSessionEntry(scope, handedOff);
    cronSession.sessionEntry.label = "stale cron owner";
    await expect(staleOwner.initialize()).rejects.toBeInstanceOf(CronSessionLifecycleClaimError);
    expect(loadSessionEntry(scope)).toMatchObject(handedOff);
  });

  it("retains embedded attempt timestamps before a transcript exists", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = "agent:main:cron:embedded-attempt";
    const cronSession = makeCronSession(
      { sessionStartedAt: 1000, lastInteractionAt: 1000 },
      storePath,
    );
    const persistedStore: Record<string, SessionEntry> = {};
    const persist = makeGuardedPersist(cronSession, sessionKey, persistedStore);

    await persist();
    cronSession.sessionEntry.lastInteractionAt = 2000;
    await persist();

    expect(persistedStore[sessionKey]).toMatchObject({
      sessionStartedAt: 1000,
      lastInteractionAt: 2000,
    });
  });

  it.each([false, true])(
    "persists native resume fields only with a transcript (present: %s) without caller SQL",
    async (transcriptPresent) => {
      const dir = sessionDirs.make();
      const storePath = path.join(dir, "sessions.json");
      const scope = {
        agentId: "main",
        sessionId: "run-session-id",
        sessionKey: "agent:main:cron:completed",
        storePath,
      };
      if (transcriptPresent) {
        await appendTranscriptMessage(scope, { message: { role: "user", content: "cron prompt" } });
      }
      const cronSession = makeCronSession(
        {
          label: "Cron: completed",
          sessionStartedAt: 1000,
          cliSessionIds: { "claude-cli": "retained-cli-session" },
        },
        storePath,
      );

      const persist = makePersist(
        cronSession,
        scope.sessionKey,
        vi.fn<CronSessionRowWriter>(async ({ operation }) => operation.next),
      );

      const reads = observeHostDataSql();
      try {
        await persist();
        expect(reads.queries).toEqual([]);
      } finally {
        reads.restore();
      }

      expect(cronSession.store["agent:main:cron:completed"]).toEqual({
        sessionId: "run-session-id",
        label: "Cron: completed",
        ...(transcriptPresent
          ? {
              sessionStartedAt: 1000,
              cliSessionIds: { "claude-cli": "retained-cli-session" },
            }
          : {}),
        updatedAt: 1000,
        systemSent: true,
      });
    },
  );

  it("claims an initial row after a benign concurrent same-generation field write", async () => {
    // Same-generation field drift must merge, not reject the initial claim.
    const sessionKey = "agent:main:session";
    const initialRevision = "initial-revision";
    const runRevision = crypto.randomUUID();
    const initialSessionEntry = makeSessionEntry({
      lifecycleRevision: initialRevision,
      totalTokens: 10,
    });
    const cronSession = makeCronSession(
      {
        lifecycleRevision: runRevision,
        status: "done",
        totalTokens: 42,
      },
      undefined,
      { initialSessionEntry, lifecycleRevision: runRevision },
    );
    const persistedStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        ...initialSessionEntry,
        // Concurrent benign update: same lifecycle generation, drifted fields.
        totalTokens: 25,
        lastInteractionAt: 2000,
        updatedAt: 2000,
      },
    };
    const persist = makeGuardedPersist(cronSession, sessionKey, persistedStore);

    await expect(persist()).resolves.toBeUndefined();

    // The run claims (its revision wins) while the concurrent update survives.
    expect(persistedStore[sessionKey]).toMatchObject({
      lifecycleRevision: runRevision,
      status: "done",
      totalTokens: 25,
      lastInteractionAt: 2000,
    });
  });

  it.each([
    { name: "a minted run revision", reused: false },
    { name: "a reused in-place revision", reused: true },
  ])(
    "does not claim the same lifecycle revision after the session id rotates with $name",
    async ({ reused }) => {
      const sessionKey = "agent:main:session";
      const initialRevision = "initial-revision";
      const runRevision = reused ? initialRevision : crypto.randomUUID();
      const initialSessionEntry = makeSessionEntry({
        sessionId: "initial-session-id",
        lifecycleRevision: initialRevision,
      });
      const cronSession = makeCronSession(
        {
          sessionId: "initial-session-id",
          lifecycleRevision: runRevision,
        },
        undefined,
        { initialSessionEntry, lifecycleRevision: runRevision },
      );
      const rotatedEntry = makeSessionEntry({
        sessionId: "rotated-session-id",
        lifecycleRevision: initialRevision,
        updatedAt: 2000,
      });
      const persistedStore: Record<string, SessionEntry> = {
        [sessionKey]: rotatedEntry,
      };
      const persist = makeGuardedPersist(cronSession, sessionKey, persistedStore);

      await expect(persist()).rejects.toBeInstanceOf(CronSessionLifecycleClaimError);

      expect(persistedStore[sessionKey]).toBe(rotatedEntry);
      expect(cronSession.store[sessionKey]).toBeUndefined();
      expect(cronSession.sessionEntry.sessionId).toBe("initial-session-id");
    },
  );

  it("claims an initial row after a concurrent pin and rename", async () => {
    const sessionKey = "agent:main:session";
    const lifecycleRevision = crypto.randomUUID();
    const initialSessionEntry = makeSessionEntry({ lifecycleRevision: "initial-revision" });
    const cronSession = {
      ...makeCronSession(
        makeSessionEntry({
          lifecycleRevision,
        }),
      ),
      initialSessionEntry,
      lifecycleRevision,
    } as MutableCronSession;
    const persistedStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        ...initialSessionEntry,
        label: "Renamed before claim",
        pinnedAt: 2000,
        updatedAt: 2000,
      },
    };
    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: sessionKey,
      workspaceDir: "/tmp/workspace",
      persistSessionEntry: makeGuardedPersistSessionEntry(persistedStore),
    });

    await expect(persist()).resolves.toBeUndefined();
    expect(persistedStore[sessionKey]).toMatchObject({
      label: "Renamed before claim",
      lifecycleRevision,
      pinnedAt: 2000,
      updatedAt: 2000,
    });
    expect(persistedStore[sessionKey]?.status).toBeUndefined();
  });

  it.each([
    {
      name: "pin and rename",
      current: { label: "Renamed", pinnedAt: 2000, updatedAt: 2000 },
      expected: { label: "Renamed", pinnedAt: 2000, updatedAt: 2000 },
    },
    {
      name: "unpin and clear the label",
      current: { label: undefined, pinnedAt: undefined, updatedAt: 2000 },
      expected: { label: undefined, pinnedAt: undefined, updatedAt: 2000 },
    },
  ])("preserves a concurrent $name during cron persistence", async ({ current, expected }) => {
    const sessionKey = "agent:main:session";
    const lifecycleRevision = crypto.randomUUID();
    const runEntry = makeSessionEntry({
      lifecycleRevision,
      label: "Original",
      pinnedAt: 1000,
      status: "done",
    });
    const cronSession = {
      ...makeCronSession(runEntry),
      initialSessionEntry: { ...runEntry },
      lifecycleRevision,
    } as MutableCronSession;
    const persistedStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        ...cronSession.sessionEntry,
        ...current,
      },
    };
    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: sessionKey,
      workspaceDir: "/tmp/workspace",
      persistSessionEntry: makeGuardedPersistSessionEntry(persistedStore),
    });

    await persist();

    expect(persistedStore[sessionKey]).toMatchObject({
      lifecycleRevision,
      status: "done",
      updatedAt: expected.updatedAt,
    });
    expect(persistedStore[sessionKey]?.label).toBe(expected.label);
    expect(persistedStore[sessionKey]?.pinnedAt).toBe(expected.pinnedAt);
    expect(cronSession.sessionEntry.label).toBe(expected.label);
    expect(cronSession.sessionEntry.pinnedAt).toBe(expected.pinnedAt);
    expect(cronSession.sessionEntry.updatedAt).toBe(expected.updatedAt);
  });

  it("does not restore session policy cleared while a cron run is active", async () => {
    const sessionKey = "agent:main:session";
    const lifecycleRevision = crypto.randomUUID();
    const initialSessionEntry = makeSessionEntry({
      lifecycleRevision,
      chatType: "direct",
      elevatedLevel: "full",
      inheritedToolAllow: ["exec"],
      sendPolicy: "allow",
    });
    const cronSession = makeCronSession(
      {
        ...initialSessionEntry,
        status: "done",
        totalTokens: 42,
      },
      undefined,
      { initialSessionEntry, lifecycleRevision },
    );
    const currentEntry: SessionEntry = {
      ...initialSessionEntry,
      chatType: "group",
      sendPolicy: "deny",
      updatedAt: 2000,
    };
    delete currentEntry.elevatedLevel;
    delete currentEntry.inheritedToolAllow;
    const persistedStore: Record<string, SessionEntry> = { [sessionKey]: currentEntry };
    const persist = makeGuardedPersist(cronSession, sessionKey, persistedStore);

    await persist();

    expect(persistedStore[sessionKey]).toMatchObject({
      chatType: "group",
      sendPolicy: "deny",
      status: "done",
      totalTokens: 42,
      updatedAt: 2000,
    });
    expect(persistedStore[sessionKey]?.elevatedLevel).toBeUndefined();
    expect(persistedStore[sessionKey]?.inheritedToolAllow).toBeUndefined();
  });

  it("adopts rotated run transcript metadata before persisting session-bound cron state", async () => {
    const cronSession = makeCronSession({ sessionId: "bound-session" });
    const changed = adoptCronRunSessionMetadata({
      entry: cronSession.sessionEntry,
      sessionKey: "agent:main:telegram:direct:42",
      runMeta: {
        sessionId: "bound-session-rotated",
        sessionFile: "/tmp/bound-session-rotated.jsonl",
      },
    });
    const persistSessionEntry = vi.fn<CronSessionRowWriter>(
      async ({ operation }) => operation.next,
    );

    expect(changed).toBe(true);
    const persist = makePersist(cronSession, "agent:main:telegram:direct:42", persistSessionEntry);

    await persist();

    expect(cronSession.store["agent:main:telegram:direct:42"]).toEqual({
      sessionId: "bound-session-rotated",
      usageFamilyKey: "agent:main:telegram:direct:42",
      usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
      updatedAt: 1000,
      systemSent: true,
    });
  });
});

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cron-session-");
