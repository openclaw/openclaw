// Tests context passed to session lifecycle hooks.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
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
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { emitResetCommandHooks } from "./commands-reset-hooks.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState as initSessionStateRaw } from "./session.js";

const initSessionState = (
  params: Omit<Parameters<typeof initSessionStateRaw>[0], "ctx"> & {
    ctx: Record<string, unknown>;
  },
) => initSessionStateRaw({ ...params, ctx: finalizeInboundContext(params.ctx) });

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

async function writeStore(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(store)) {
    const sessionEntry = entry as Partial<SessionEntry>;
    if (typeof sessionEntry.sessionId === "string" && sessionEntry.sessionId.trim()) {
      await replaceSessionEntry({ storePath, sessionKey }, sessionEntry as SessionEntry);
    }
  }
}

async function writeTranscript(
  storePath: string,
  sessionId: string,
  text = "hello",
): Promise<string> {
  const transcriptPath = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      id: `${sessionId}-m1`,
      message: { role: "user", content: text },
    })}\n`,
    "utf-8",
  );
  return transcriptPath;
}

async function createStoredSession(params: {
  prefix: string;
  sessionKey: string;
  sessionId: string;
  text?: string;
  updatedAt?: number;
}): Promise<{ storePath: string; transcriptPath: string }> {
  const storePath = await createStorePath(params.prefix);
  const transcriptPath = await writeTranscript(storePath, params.sessionId, params.text);
  await writeStore(storePath, {
    [params.sessionKey]: {
      sessionId: params.sessionId,
      sessionFile: transcriptPath,
      updatedAt: params.updatedAt ?? Date.now(),
    },
  });
  return { storePath, transcriptPath };
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function requireHookCall(
  mock: ReturnType<typeof vi.fn>,
  label: string,
): readonly [Record<string, unknown>, Record<string, unknown> | undefined] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} hook call`);
  }
  const [event, context] = call;
  if (!event || typeof event !== "object") {
    throw new Error(`expected ${label} hook event`);
  }
  if (context !== undefined && (!context || typeof context !== "object")) {
    throw new Error(`expected ${label} hook context`);
  }
  return [event as Record<string, unknown>, context as Record<string, unknown> | undefined];
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
    hookRunnerMocks.runSessionStart.mockReset();
    hookRunnerMocks.runSessionEnd.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockClear();
    sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockResolvedValue(0);
    sessionCleanupMocks.resetRegisteredAgentHarnessSessions.mockClear();
    sessionCleanupMocks.retireSessionMcpRuntime.mockClear();
    hookRunnerMocks.runSessionStart.mockResolvedValue(undefined);
    hookRunnerMocks.runSessionEnd.mockResolvedValue(undefined);
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
    hookRunnerMocks.hasHooks.mockImplementation(
      (hookName) => hookName === "session_start" || hookName === "session_end",
    );
  });

  afterEach(() => {
    clearInternalHooks();
    resetGatewayWorkAdmission();
    vi.restoreAllMocks();
  });

  it("captures the retiring memory window before new", async () => {
    const sessionKey = "agent:main:memory-reset";
    const sessionId = "memory-reset-session";
    const storePath = await createStorePath("memory-new");
    const workspaceDir = path.join(path.dirname(storePath), "workspace");
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: workspaceDir } },
      hooks: { internal: { enabled: true, entries: { "session-memory": { enabled: true } } } },
      session: { store: storePath },
    };
    await writeStore(storePath, {
      [sessionKey]: { sessionId, updatedAt: Date.now() },
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
    registerInternalHook("command:new", saveSessionMemory);
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_reset");

    try {
      const ctx = { Body: "/new", SessionKey: sessionKey };
      const initialized = await initSessionState({ ctx, cfg, commandAuthorized: true });
      await emitResetCommandHooks({
        ...initialized,
        action: "new",
        agentId: "main",
        cfg,
        ctx,
        command: { surface: "webchat", channel: "webchat" },
        workspaceDir,
      });
      await flushSessionMemoryWritesForTest();
      const memoryDir = path.join(workspaceDir, "memory");
      const files = await fs.readdir(memoryDir);
      expect(files).toHaveLength(1);
      const content = await fs.readFile(path.join(memoryDir, files[0]!), "utf8");
      expect(content).toContain('assistant: "retiring-memory-5"');
      expect(content).toContain('assistant: "retiring-memory-19"');
      expect(content).not.toContain('"retiring-memory-4"');
      expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledOnce();
      expect(hookRunnerMocks.runBeforeReset.mock.calls[0]?.[0].messages).toHaveLength(20);
      expect(hookRunnerMocks.runBeforeReset.mock.calls[0]?.[0].messages?.[0]).toMatchObject({
        content: "retiring-memory-0",
      });
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
        const admission = await beginSessionWorkAdmission({
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
    const initialized = initSessionState({
      ctx: { Body: "First turn", SessionKey: sessionKey },
      cfg: { session: { store: storePath } },
      commandAuthorized: true,
    });
    await withinTest(Promise.all([initialized, completed.promise]), signal);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledOnce();
  });

  it("keeps rollover hooks alive after their requester closes", async ({ signal }) => {
    const releases: Array<() => void> = [];
    const completedHooks: string[] = [];
    const held = (name: string) => async () => {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      await trackAsyncWork(() => {
        completedHooks.push(name);
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
    const sessionKey = "agent:main:telegram:direct:held-rollover";
    const { storePath } = await createStoredSession({
      prefix: "openclaw-session-hook-held-rollover",
      sessionKey,
      sessionId: "old-held-session",
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
        parent.run(() =>
          initSessionState({
            ctx: { Body: "/new", SessionKey: sessionKey },
            cfg: { session: { store: storePath } } as OpenClawConfig,
            commandAuthorized: true,
          }),
        ),
      );
      expect(releases).toHaveLength(3);
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
  });

  it("hands rollover hooks off after restart drain closes admission", async () => {
    const releases: Array<() => void> = [];
    const held = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    hookRunnerMocks.runSessionEnd.mockImplementationOnce(held);
    hookRunnerMocks.runSessionStart.mockImplementationOnce(held);
    sessionCleanupMocks.closeTrackedBrowserTabsForSessions.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          releases.push(() => resolve(0));
        }),
    );
    const sessionKey = "agent:main:telegram:direct:restart-handoff";
    const { storePath } = await createStoredSession({
      prefix: "openclaw-session-hook-restart-handoff",
      sessionKey,
      sessionId: "old-restart-session",
    });
    const admission = tryBeginGatewayRootWorkAdmission();
    expect(admission).not.toBeNull();

    await admission?.run(async () => {
      markGatewayRestartDraining();
      await initSessionState({
        ctx: { Body: "/new", SessionKey: sessionKey },
        cfg: { session: { store: storePath } } as OpenClawConfig,
        commandAuthorized: true,
      });
      await vi.waitFor(() => expect(releases).toHaveLength(3));
      expect(getActiveGatewayRootWorkCount()).toBe(4);
    });

    admission?.release();
    expect(getActiveGatewayRootWorkCount()).toBe(3);
    for (const release of releases) {
      release();
    }
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(hookRunnerMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
  });

  it("marks explicit /reset rollovers with reason reset", async () => {
    const sessionKey = "agent:main:telegram:direct:456";
    const { storePath } = await createStoredSession({
      prefix: "openclaw-session-hook-explicit-reset",
      sessionKey,
      sessionId: "reset-session",
      text: "reset me",
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/reset", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    const [event] = requireHookCall(hookRunnerMocks.runSessionEnd, "session_end");
    expectFields(event, { reason: "reset" });
  });

  it("maps custom reset trigger aliases to the new-session reason", async () => {
    const sessionKey = "agent:main:telegram:direct:alias";
    const { storePath } = await createStoredSession({
      prefix: "openclaw-session-hook-reset-alias",
      sessionKey,
      sessionId: "alias-session",
      text: "alias me",
    });
    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/fresh"],
      },
    } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/fresh", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    const [event] = requireHookCall(hookRunnerMocks.runSessionEnd, "session_end");
    expectFields(event, { reason: "new" });
  });
});
