// Tests context passed to session lifecycle hooks.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import * as memoryCapture from "../../hooks/bundled/session-memory/capture.js";
import saveSessionMemory, {
  flushSessionMemoryWritesForTest,
} from "../../hooks/bundled/session-memory/handler.js";
import { clearInternalHooks, registerInternalHook } from "../../hooks/internal-hooks.js";
import type { HookRunner } from "../../plugins/hooks.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { emitResetCommandHooks } from "./commands-reset-hooks.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState as initSessionStateRaw } from "./session.js";

const initSessionState = (
  params: Omit<Parameters<typeof initSessionStateRaw>[0], "ctx"> & {
    ctx: Record<string, unknown>;
  },
) => initSessionStateRaw({ ...params, ctx: finalizeInboundContext(params.ctx) });

function startSession(storePath: string, sessionKey: string, Body = "hello") {
  return initSessionState({
    ctx: { Body, SessionKey: sessionKey },
    cfg: { session: { store: storePath } },
    commandAuthorized: true,
  });
}

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runSessionStart: vi.fn<HookRunner["runSessionStart"]>(),
  runSessionEnd: vi.fn<HookRunner["runSessionEnd"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
}));
const sessionCleanupMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
  resetRegisteredAgentHarnessSessions: vi.fn(async () => undefined),
  retireSessionMcpRuntime: vi.fn(async () => false),
}));

// mock-isolation: Keep global hook dispatch on this suite's synthetic lifecycle handlers.
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runSessionStart: hookRunnerMocks.runSessionStart,
      runSessionEnd: hookRunnerMocks.runSessionEnd,
      runBeforeReset: hookRunnerMocks.runBeforeReset,
    }) as unknown as HookRunner,
}));

vi.mock("../../agents/harness/registry.js", () => ({
  resetRegisteredAgentHarnessSessions: sessionCleanupMocks.resetRegisteredAgentHarnessSessions,
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: sessionCleanupMocks.retireSessionMcpRuntime,
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: sessionCleanupMocks.closeTrackedBrowserTabsForSessions,
}));

const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-session-hooks-" });

async function createStorePath(prefix: string): Promise<string> {
  const root = await suiteTempDirs.make(prefix);
  return path.join(root, "sessions.json");
}

async function writeStore(storePath: string, store: Record<string, SessionEntry>): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(store)) {
    await replaceSessionEntry({ storePath, sessionKey }, entry);
  }
}

async function createStoredSession(params: {
  prefix: string;
  sessionKey: string;
  sessionId: string;
  updatedAt?: number;
}) {
  const storePath = await createStorePath(params.prefix);
  await writeStore(storePath, {
    [params.sessionKey]: {
      sessionId: params.sessionId,
      updatedAt: params.updatedAt ?? Date.now(),
    },
  });
  return { storePath };
}

type SessionResetConfig = NonNullable<NonNullable<OpenClawConfig["session"]>["reset"]>;

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toMatchObject(expected);
}

function requireHookCall<T extends unknown[]>(mock: { mock: { calls: T[] } }, label: string): T {
  expect(mock, label).toHaveBeenCalled();
  return mock.mock.calls[0]!;
}

function holdRolloverHooks(completed: string[]) {
  const releases: Array<() => void> = [];
  const held = (name: string) => async () => {
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    await trackAsyncWork(() => {
      completed.push(name);
    });
  };
  hookRunnerMocks.runSessionEnd.mockImplementationOnce(held("end"));
  hookRunnerMocks.runSessionStart.mockImplementationOnce(held("start"));
  sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        releases.push(() => resolve(0));
      }),
  );
  return releases;
}

describe("session hook context wiring", () => {
  beforeAll(async () => {
    await suiteTempDirs.setup();
  });

  afterAll(async () => {
    await suiteTempDirs.cleanup();
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runSessionStart.mockReset().mockResolvedValue(undefined);
    hookRunnerMocks.runSessionEnd.mockReset().mockResolvedValue(undefined);
    hookRunnerMocks.runBeforeReset.mockReset().mockResolvedValue(undefined);
    sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockClear();
    sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockResolvedValue(0);
    sessionCleanupMocks.resetRegisteredAgentHarnessSessions.mockClear();
    sessionCleanupMocks.retireSessionMcpRuntime.mockClear();
    hookRunnerMocks.hasHooks.mockImplementation(
      (hookName) => hookName === "session_start" || hookName === "session_end",
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    clearInternalHooks();
    resetGatewayWorkAdmission();
    vi.restoreAllMocks();
  });

  it.each<["new" | "reset" | "daily" | "idle", SessionResetConfig?]>([
    ["new"],
    ["reset"],
    ["daily", { mode: "daily" }],
    ["idle", { mode: "idle", idleMinutes: 30 }],
    ["idle", { mode: "daily", atHour: 4, idleMinutes: 30 }],
  ])("captures retiring memory and emits rollover hooks: %s (%j)", async (reason, reset) => {
    const overlap = reason === "idle" && reset?.mode === "daily";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 18, 5, overlap ? 30 : 0, 0));
    const projectionRepair = reason === "reset" || reason === "idle";
    const sessionKey = "agent:main:memory-reset";
    const sessionId = "memory-reset-session";
    const storePath = await createStorePath(`memory-${reason}`);
    const workspaceDir = path.join(path.dirname(storePath), "workspace");
    const automatic = reason === "daily" || reason === "idle";
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: workspaceDir } },
      hooks: { internal: { enabled: true, entries: { "session-memory": { enabled: true } } } },
      session: { store: storePath, reset },
    };
    await writeStore(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt: automatic
          ? new Date(2026, 0, 18, overlap ? 4 : 3, overlap ? 45 : 0, 0).getTime()
          : Date.now(),
      },
    });
    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey, storePath },
      Array.from({ length: 20 }, (_, index) => ({
        type: "message",
        id: `message-${index}`,
        parentId: index === 0 ? null : `message-${index - 1}`,
        timestamp: new Date().toISOString(),
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `retiring-memory-${index}`,
        },
      })),
    );
    registerInternalHook(automatic ? "session:auto-reset" : `command:${reason}`, saveSessionMemory);
    const listener = vi.fn();
    registerInternalHook("session:auto-reset", listener);
    if (projectionRepair) {
      await sessionAccessor.waitForSessionTranscriptProjection({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
      });
      const database = openOpenClawAgentDatabase(
        toDatabaseOptions(
          resolveSqliteTranscriptReadScope({ agentId: "main", sessionId, sessionKey, storePath }),
        ),
      );
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(sessionId);
    }
    hookRunnerMocks.hasHooks.mockImplementation(
      (hookName) =>
        hookName === "session_start" ||
        hookName === "session_end" ||
        (!automatic && hookName === "before_reset"),
    );

    try {
      const body = automatic ? "Start the next turn" : `/${reason}`;
      const ctx = { Body: body, SessionKey: sessionKey };
      const initialized = await initSessionState({ ctx, cfg, commandAuthorized: true });
      if (!automatic) {
        await emitResetCommandHooks({
          ...initialized,
          action: reason,
          agentId: "main",
          cfg,
          ctx,
          command: { surface: "webchat", channel: "webchat" },
          workspaceDir,
        });
      }
      await flushSessionMemoryWritesForTest();
      const memoryDir = path.join(workspaceDir, "memory");
      const files = await fs.readdir(memoryDir);
      expect(files).toHaveLength(1);
      const content = await fs.readFile(path.join(memoryDir, files[0]!), "utf8");
      expect(content).toContain('assistant: "retiring-memory-5"');
      expect(content).toContain('assistant: "retiring-memory-19"');
      expect(content).not.toContain('"retiring-memory-4"');
      if (automatic) {
        const [ended] = requireHookCall(hookRunnerMocks.runSessionEnd, "session_end");
        const [started] = requireHookCall(hookRunnerMocks.runSessionStart, "session_start");
        expectFields(ended, { reason, nextSessionId: sessionId });
        expectFields(started, { sessionId });
        await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
        const [event] = listener.mock.calls[0]!;
        expectFields(event, {
          type: "session",
          action: "auto-reset",
          sessionKey,
          context: { reason, nextSessionKey: sessionKey },
        });
      } else {
        expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledOnce();
        expect(hookRunnerMocks.runBeforeReset.mock.calls[0]?.[0].messages).toHaveLength(20);
        expect(hookRunnerMocks.runBeforeReset.mock.calls[0]?.[0].messages?.[0]).toMatchObject({
          content: "retiring-memory-0",
        });
      }
    } finally {
      await flushSessionMemoryWritesForTest();
    }
  });

  it.each(["stale", "failed"] as const)(
    "does not publish a memory snapshot from a %s lifecycle commit",
    async (outcome) => {
      const sessionKey = "agent:main:memory-conflict";
      const storePath = await createStorePath("memory-conflict");
      const scope = { agentId: "main", sessionId: "retiring", sessionKey, storePath };
      await writeStore(storePath, {
        [sessionKey]: { sessionId: scope.sessionId, updatedAt: Date.now() - 86_400_000 },
      });
      await replaceTranscriptEvents(scope, [
        { type: "message", id: "old", parentId: null, message: { role: "user", content: "old" } },
      ]);
      const onReset = vi.fn();
      registerInternalHook("session:auto-reset", onReset);
      const read = vi.spyOn(memoryCapture, "captureSessionMemoryTranscript");
      const commit = sessionAccessor.commitReplySessionInitialization;
      vi.spyOn(sessionAccessor, "commitReplySessionInitialization").mockImplementationOnce(
        (params) =>
          commit({
            ...params,
            beforeEntryMutation: async (context) => {
              await params.beforeEntryMutation?.(context);
              if (outcome === "failed") {
                throw new Error("lifecycle commit failed");
              }
              sessionAccessor.replaceSessionEntrySync(scope, {
                sessionId: "replacement",
                updatedAt: Date.now(),
              });
            },
          }),
      );
      const initialized = initSessionState({
        ctx: { Body: "Continue", SessionKey: sessionKey },
        cfg: { session: { store: storePath, reset: { mode: "idle", idleMinutes: 30 } } },
        commandAuthorized: true,
      });
      if (outcome === "failed") {
        await expect(initialized).rejects.toThrow("lifecycle commit failed");
      } else {
        const result = await initialized;
        expect(result.sessionId).toBe("replacement");
        expect(result.previousSessionMemory).toBeUndefined();
      }
      expect(read).toHaveBeenCalledOnce();
      expect(onReset).not.toHaveBeenCalled();
    },
  );

  it.for([
    { kind: "new", dmScope: "main" },
    { kind: "admitted", dmScope: "main" },
    { kind: "existing", dmScope: "per-channel-peer" },
  ] as const)(
    "initializes independent first turns while a $kind session is still preparing ($dmScope)",
    async ({ kind, dmScope }, { signal }) => {
      const storePath = await createStorePath("independent-first-turns");
      const key = "agent:main:dashboard:first";
      const sessionId = "admitted-first-session";
      await writeStore(
        storePath,
        kind === "new" ? {} : { [key]: { sessionId, updatedAt: Date.now() } },
      );
      const cfg = { session: { store: storePath, dmScope } };
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const commit = sessionAccessor.commitReplySessionInitialization;
      vi.spyOn(sessionAccessor, "commitReplySessionInitialization").mockImplementationOnce(
        async (params) => {
          entered.resolve();
          await release.promise;
          return commit(params);
        },
      );
      const first = initSessionState({
        ctx: {
          Body: "First turn",
          SessionKey: key,
          OriginatingChannel: "webchat",
          OriginatingTo: key,
        },
        cfg,
        commandAuthorized: true,
        ...(kind === "admitted"
          ? {
              expectedExistingSessionId: sessionId,
              pinExpectedExistingSession: true,
              newlyCreatedSessionId: sessionId,
            }
          : {}),
      });
      let second: ReturnType<typeof initSessionState> | undefined;
      try {
        await withinTest(entered.promise, signal);
        second = initSessionState({
          ctx: {
            Body: "Independent turn",
            SessionKey: "agent:main:dashboard:second",
            OriginatingChannel: "webchat",
            OriginatingTo: "agent:main:dashboard:second",
          },
          cfg,
          commandAuthorized: true,
        });
        const initialized = await withinTest(second, signal);
        expect(initialized.sessionKey).toBe("agent:main:dashboard:second");
        expect(initialized.isNewSession).toBe(true);
        expect(loadSessionEntry({ storePath, sessionKey: initialized.sessionKey })?.sessionId).toBe(
          initialized.sessionId,
        );
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
      }
      expect((await first).isNewSession).toBe(kind !== "existing");
    },
  );

  it("allows a first-turn hook to admit session work without borrowing the initialization writer", async ({
    signal,
  }) => {
    const storePath = await createStorePath("first-turn-hook-admission");
    const sessionKey = "agent:main:dashboard:hook-source";
    const completed = createDeferredCore();
    hookRunnerMocks.runSessionStart.mockImplementation(async () => {
      try {
        // The plugin runtime's runWithWorkAdmission API requests this broad writer barrier.
        const admission = await beginSessionEffect({
          scope: storePath,
          identities: ["agent:main:dashboard:hook-target"],
          assertAllowed: () => {},
        });
        admission.release();
        completed.resolve();
      } catch (error) {
        completed.reject(error);
      }
    });
    const initialized = startSession(storePath, sessionKey, "First turn");
    await withinTest(Promise.all([initialized, completed.promise]), signal);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledOnce();
    const [event, context] = requireHookCall(hookRunnerMocks.runSessionStart, "session_start");
    expectFields(event, { sessionKey });
    expectFields(context, { sessionKey, agentId: "main", sessionId: event.sessionId });
  });

  it("runs an unawaited session_start hook outside the reply turn that emitted it", async () => {
    // The hook outlives the turn; resuming that retired admission would reject its own turn.
    const sessionKey = "agent:main:hook-after-turn";
    const storePath = await createStorePath("openclaw-session-hook-after-turn");
    await writeStore(storePath, {});
    const turnSettled = createDeferred();
    const hookAdmission = createDeferred<unknown>();
    hookRunnerMocks.runSessionStart.mockImplementation(async (event) => {
      await turnSettled.promise;
      try {
        hookAdmission.resolve(
          await withSessionTurn(
            { storePath, sessionKey, sessionId: event.sessionId },
            async (operation) => operation?.key,
          ),
        );
      } catch (error) {
        hookAdmission.resolve(error);
      }
    });

    await withSessionTurn({ storePath, sessionKey }, () => startSession(storePath, sessionKey));
    turnSettled.resolve();

    await expect(hookAdmission.promise).resolves.toBe(sessionKey);
  });

  it("starts the first reply lifecycle for a session created by admission without resetting it", async () => {
    const sessionKey = "agent:main:dashboard:admitted-goal";
    const sessionId = "admitted-session";
    const storePath = await createStorePath("openclaw-session-hook-admission");
    const now = Date.now();
    const seed: SessionEntry = {
      sessionId,
      lifecycleRevision: "admitted-generation",
      updatedAt: now,
      sessionStartedAt: now,
      ...buildSessionCreationStamp({
        via: "operator",
        actor: { type: "human", source: "profile", id: "profile-ada" },
        sandbox: "required",
        now,
      }),
      goal: {
        schemaVersion: 1,
        id: "admitted-goal",
        objective: "Start the first task",
        status: "active",
        createdAt: now,
        updatedAt: now,
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 0,
      },
    };
    await writeStore(storePath, { [sessionKey]: seed });
    const params = {
      ctx: { Body: seed.goal?.objective, SessionKey: sessionKey },
      cfg: { session: { store: storePath } } as OpenClawConfig,
      commandAuthorized: true,
      expectedExistingSessionId: sessionId,
      pinExpectedExistingSession: true,
    };
    const result = await initSessionState({ ...params, newlyCreatedSessionId: sessionId });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionCtx.IsNewSession).toBe("true");
    expect(result.resetTriggered).toBe(false);
    expect(result.previousSessionEntry).toBeUndefined();
    const preserved = {
      sessionId,
      lifecycleRevision: seed.lifecycleRevision,
      sessionStartedAt: now,
      goal: seed.goal,
      createdAt: now,
      createdActor: seed.createdActor,
      sandbox: "required",
    };
    expect(result.sessionEntry).toMatchObject(preserved);
    expect(loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })).toMatchObject(
      preserved,
    );
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSessionEnd).not.toHaveBeenCalled();
    expectFields(requireHookCall(hookRunnerMocks.runSessionStart, "session_start")[0], {
      sessionKey,
      sessionId,
      resumedFrom: undefined,
    });

    const next = await initSessionState(params);
    expect(next.isNewSession).toBe(false);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
  });

  it.for([false, true])(
    "keeps rollover hooks alive after their requester closes (restart drain: %s)",
    async (draining, { signal }) => {
      const completedHooks: string[] = [];
      const releases = holdRolloverHooks(completedHooks);
      const sessionKey = "agent:main:telegram:direct:held-rollover";
      const sessionId = "old-held-session";
      const { storePath } = await createStoredSession({
        prefix: "held-rollover",
        sessionKey,
        sessionId,
      });
      const owner = await import("../../process/gateway-work-admission.js");
      const continuations = [
        vi.spyOn(owner, "runWithGatewayIndependentRootWorkContinuation"),
        vi.spyOn(owner, "runWithGatewayDetachedWorkContinuation"),
      ];
      const joinContinuations = () =>
        Promise.allSettled(
          continuations.flatMap((spy) =>
            spy.mock.results
              .filter((result) => result.type === "return")
              .map((result) => result.value),
          ),
        );
      const parent = new AsyncWorkScope();
      const admission = tryBeginGatewayRootWorkAdmission("test:reply-rollover");
      if (!admission) {
        throw new Error("Expected parent root admission");
      }
      try {
        await admission.run(() =>
          parent.run(async () => {
            if (draining) {
              markGatewayRestartDraining();
            }
            await startSession(storePath, sessionKey, draining ? "/new" : "/reset");
            await vi.waitFor(() => expect(releases).toHaveLength(3));
            expect(getActiveGatewayRootWorkCount()).toBe(4);
          }),
        );
        expect(hookRunnerMocks.runSessionEnd).toHaveBeenCalledOnce();
        expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledOnce();
        const [ended, endContext] = requireHookCall(hookRunnerMocks.runSessionEnd, "session_end");
        expectFields(ended, {
          sessionKey,
          reason: draining ? "new" : "reset",
          nextSessionId: sessionId,
        });
        expectFields(endContext, { sessionKey, agentId: "main", sessionId: ended.sessionId });
        const [started, startContext] = requireHookCall(
          hookRunnerMocks.runSessionStart,
          "session_start",
        );
        expectFields(started, { sessionId, resumedFrom: sessionId });
        expectFields(startContext, { sessionId: started.sessionId });
        admission.release();
        await withinTest(parent.drain(), signal);
        expect(getActiveGatewayRootWorkCount()).toBe(3);
        expect(completedHooks).toEqual([]);
        for (const release of releases) {
          release();
        }
        await withinTest(joinContinuations(), signal);
        expect(completedHooks.toSorted()).toEqual(["end", "start"]);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        for (const release of releases) {
          release();
        }
        admission.release();
        await parent.drain();
        await joinContinuations();
        for (const spy of continuations) {
          spy.mockRestore();
        }
      }
    },
  );
});
