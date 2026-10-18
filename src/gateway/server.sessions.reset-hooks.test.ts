import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { PluginHookSessionContext } from "../plugins/session-end-transcript.js";
import { readAttachedSessionEndTranscriptSourceForTest } from "../plugins/session-end-transcript.test-support.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { embeddedRunMock, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsHandlerTestHarness,
  sessionHookMocks,
  beforeResetHookMocks,
  sessionLifecycleHookMocks,
  beforeResetHookState,
  writeSingleLineSession,
  sessionStoreEntry,
  directSessionReq,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const pendingHookCleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  // A runner timeout does not unwind the test body; settle gates before store teardown.
  for (const cleanup of pendingHookCleanups) {
    await cleanup();
  }
  pendingHookCleanups.clear();
});

type HookEventRecord = Record<string, unknown>;

type CommandNewHookEvent = {
  type: string;
  action: string;
  sessionKey?: string;
  context?: {
    agentId?: string;
    commandSource?: string;
  };
};

function firstHookCall(mock: { mock: { calls: unknown[][] } }): [HookEventRecord, HookEventRecord] {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected hook call");
  }
  return [call[0] as HookEventRecord, call[1] as HookEventRecord];
}

function expectStringValue(value: unknown, label: string): string {
  expect(typeof value, label).toBe("string");
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

async function withGlobalAgentSessionStore(run: (storePath: string) => Promise<void>) {
  const { dir } = await createSessionStoreDir();
  const storeTemplate = path.join(dir, "agents", "{agentId}", "sessions", "sessions.json");
  const configPath = expectStringValue(process.env.OPENCLAW_CONFIG_PATH, "OPENCLAW_CONFIG_PATH");
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js");
  testState.sessionStorePath = storeTemplate;
  testState.sessionConfig = { scope: "global" };
  await fs.writeFile(
    configPath,
    JSON.stringify({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, work: {} },
      },
      session: { scope: "global", store: storeTemplate },
    }),
    "utf-8",
  );
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  try {
    await run(storeTemplate.replace("{agentId}", "work"));
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    await fs.writeFile(configPath, "{}\n", "utf-8");
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  }
}

async function writeStoredSession(
  sessionId: string,
  {
    key = "main",
    content,
    messageId = "m1",
    ...entry
  }: Parameters<typeof sessionStoreEntry>[1] & {
    key?: string;
    content?: string;
    messageId?: string;
  } = {},
) {
  const storePath = expectStringValue(testState.sessionStorePath, "testState.sessionStorePath");
  await writeSessionStore({ entries: { [key]: sessionStoreEntry(sessionId, entry) } });
  if (content !== undefined) {
    await seedSessionTranscript({
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${key}`,
      storePath,
      messages: [{ role: "user", content, id: messageId }],
    });
  }
  return formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
}

async function resetSession(key = "main") {
  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key,
    reason: "new",
  });
  expect(reset.ok).toBe(true);
  return reset;
}

async function resetWithBroadcast(key: string, connId: string) {
  const broadcast = vi.fn();
  const reset = await directSessionReq<{ key: string; deleted?: boolean }>(
    "sessions.reset",
    { key, reason: "reset" },
    {
      context: {
        broadcastToConnIds: broadcast,
        getSessionEventSubscriberConnIds: () => new Set([connId]),
      },
    },
  );
  expect(reset.ok).toBe(true);
  return { reset, broadcast };
}

function createFromMainSession(params: { emitCommandHooks?: boolean; key?: string } = {}) {
  return directSessionReq<{ key: string; sessionId: string; runStarted: boolean }>(
    "sessions.create",
    {
      parentSessionKey: "main",
      ...params,
    },
  );
}

async function performSessionReset(params: {
  key: string;
  agentId?: string;
  reason: "new" | "reset";
  commandSource: string;
  assertCurrent?: () => void;
}) {
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  return performGatewaySessionReset({ ...params, workerPlacementContext: {} });
}

function isCommandHookEvent(event: unknown, action: string): event is CommandNewHookEvent {
  return (
    Boolean(event) &&
    typeof event === "object" &&
    (event as { type?: unknown }).type === "command" &&
    (event as { action?: unknown }).action === action
  );
}

function commandHookEvents(action = "new") {
  return (sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>)
    .map((call) => call[0])
    .filter((event) => isCommandHookEvent(event, action));
}

function expectSingleCommandHookEvent(action: "new" | "reset") {
  const events = commandHookEvents(action);
  expect(events).toHaveLength(1);
  const event = events[0];
  if (!event) {
    throw new Error(`expected command ${action} hook event`);
  }
  expect(event.type).toBe("command");
  expect(event.action).toBe(action);
  return event;
}

function claudeCliBindings(sessionId: string) {
  return {
    claudeCliSessionId: sessionId,
    cliSessionBindings: { "claude-cli": { sessionId } },
    cliSessionIds: { "claude-cli": sessionId },
  };
}

async function loadGatewaySessionStoreForKey(key: string) {
  const [{ getRuntimeConfig }, { resolveGatewaySessionStoreTargetInWorker }] = await Promise.all([
    import("../config/config.js"),
    import("./session-utils-store-worker.js"),
  ]);
  const { storePath } = await resolveGatewaySessionStoreTargetInWorker({
    cfg: getRuntimeConfig(),
    key,
  });
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

function expectNoCreationHooks() {
  expect(commandHookEvents()).toHaveLength(0);
  expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();
}

function lifecycleEvents(): [HookEventRecord, HookEventRecord] {
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionStart).toHaveBeenCalledTimes(1);
  return [
    firstHookCall(sessionLifecycleHookMocks.runSessionEnd)[0],
    firstHookCall(sessionLifecycleHookMocks.runSessionStart)[0],
  ];
}

async function withMainDmScope(run: () => Promise<void>) {
  testState.sessionConfig = { dmScope: "main" };
  try {
    await run();
  } finally {
    testState.sessionConfig = undefined;
  }
}

test("sessions.reset removes automatic recovery state from the replacement session", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-recovery", "hello");
  await writeStoredSession("sess-recovery", {
    abortedLastRun: true,
    restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration: "generation-1" }],
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 5,
      chargedAttempts: 3,
      foregroundClaims: {
        lifecycleGeneration: "generation-1",
        tokens: ["foreground-owner"],
      },
      tombstone: { reason: "exhausted" },
    },
    subagentRecovery: {
      automaticAttempts: 2,
      lastAttemptAt: 10,
      lastRunId: "child-recovery-run",
      wedgedAt: 20,
      wedgedReason: "child exhausted",
    },
  });

  await resetSession();

  const store = await loadGatewaySessionStoreForKey("main");
  const replacement = store["agent:main:main"];
  expect(replacement).toMatchObject({ sessionId: "sess-recovery", abortedLastRun: false });
  expect(replacement?.restartRecoveryRuns).toBeUndefined();
  expect((replacement as InternalSessionEntry | undefined)?.mainRestartRecovery).toBeUndefined();
  expect(replacement?.subagentRecovery).toBeUndefined();
});

test("sessions.reset does not begin cleanup after losing lifecycle ownership", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeStoredSession("sess-main");
  let ownershipChecks = 0;

  await expect(
    performSessionReset({
      key: "main",
      reason: "new",
      commandSource: "gateway:agent",
      assertCurrent: () => {
        ownershipChecks += 1;
        if (ownershipChecks >= 2) {
          const error = new Error("stale lifecycle");
          error.name = "AbortError";
          throw error;
        }
      },
    }),
  ).rejects.toThrow("stale lifecycle");

  expect(ownershipChecks).toBe(2);
  const store = await loadGatewaySessionStoreForKey("main");
  expect(store["agent:main:main"]?.sessionId).toBe("sess-main");
});

test.each([
  { key: "agent:main:main", agentId: "work", message: "session key agent does not match agentId" },
  { key: "agent:typo:main", agentId: undefined, message: "Unknown agent id: typo" },
])("sessions.reset rejects invalid global selection: $message", async ({ message, ...target }) => {
  await withGlobalAgentSessionStore(async () => {
    const reset = await performSessionReset({
      ...target,
      reason: "reset",
      commandSource: "gateway:sessions.reset",
    });
    expect(reset).toMatchObject({ ok: false, error: { message } });
  });
});

test.each(["!!!", "   "])(
  "sessions.reset rejects an unrepresentable explicit agent %j without resetting main",
  async (agentId) => {
    const { storePath } = await createSessionStoreDir();
    await writeStoredSession("sess-preserved");
    const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
    const before = loadSessionEntry(scope);

    const reset = await directSessionReq("sessions.reset", {
      key: scope.sessionKey,
      agentId,
    });

    expect(reset.ok).toBe(false);
    expect(reset.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("Unknown agent id"),
    });
    expect(loadSessionEntry(scope)).toEqual(before);
    expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
  },
);

test("sessions.reset emits inferred selected global agent scope", async () => {
  await withGlobalAgentSessionStore(async (storePath) => {
    await writeSessionStore({
      agentId: "work",
      storePath,
      entries: { global: sessionStoreEntry("sess-work-global") },
    });
    const { broadcast } = await resetWithBroadcast("agent:work:main", "conn-work");
    for (const [index, name] of ["socket.drain", "sessions.changed"].entries()) {
      expect(broadcast.mock.calls[index]?.slice(0, 3)).toEqual([
        name,
        expect.objectContaining({ sessionKey: "global", agentId: "work", reason: "reset" }),
        new Set(["conn-work"]),
      ]);
    }
    const hookEvent = expectSingleCommandHookEvent("reset");
    expect(hookEvent.sessionKey).toBe("global");
    expect(hookEvent.context?.agentId).toBe("work");
  });
});

test("sessions.reset of an incognito session broadcasts a delete, not a reset", async () => {
  await createSessionStoreDir();
  const location = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
  };
  const sessionKey = "agent:main:dashboard:incognito-chat";
  const scope = { agentId: "main", storePath: location.path, sessionKey };
  try {
    await upsertSessionEntryCore(scope, sessionStoreEntry("sess-incognito", { incognito: true }));
    const { reset, broadcast } = await resetWithBroadcast(sessionKey, "conn-incognito");
    expect(reset.payload?.deleted).toBe(true);
    expect(loadSessionEntry(scope)).toBeUndefined();
    const [, incognitoEndContext] = firstHookCall(sessionLifecycleHookMocks.runSessionEnd);
    const transcript = readAttachedSessionEndTranscriptSourceForTest(
      incognitoEndContext as PluginHookSessionContext,
    );
    expect(transcript).toEqual({ available: false, reason: "incognito-deleted" });
    // The row is gone; only reason "delete" makes clients drop it and navigate away.
    expect(broadcast.mock.calls[0]?.[0]).toBe("socket.drain");
    expect(broadcast.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ reason: "delete" }));
    expect(broadcast.mock.calls[1]?.[0]).toBe("sessions.changed");
    expect(broadcast.mock.calls[1]?.[1]).toEqual({
      sessionKey: reset.payload?.key,
      agentId: "main",
      sessionId: "sess-incognito",
      reason: "delete",
      ts: expect.any(Number),
    });
  } finally {
    memorySessionActorOwners.closeDatabase(location);
  }
});

test("sessions.create with emitCommandHooks=true emits reset lifecycle hooks against parent (#76957)", async () => {
  await createSessionStoreDir();
  const transcriptPath = await writeStoredSession("sess-parent-hooks", {
    content: "remember this before new",
  });

  beforeResetHookState.hasBeforeResetHook = true;

  expect((await createFromMainSession({ emitCommandHooks: true })).ok).toBe(true);

  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  const [beforeResetEvent, beforeResetContext] = firstHookCall(beforeResetHookMocks.runBeforeReset);
  expect(beforeResetEvent).toMatchObject({
    sessionFile: transcriptPath,
    reason: "new",
    messages: [{ role: "user", content: "remember this before new" }],
  });
  expect(beforeResetContext).toMatchObject({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "sess-parent-hooks",
  });

  const [endEvent, startEvent] = lifecycleEvents();
  expect(endEvent).toMatchObject({
    sessionId: "sess-parent-hooks",
    sessionKey: "agent:main:main",
    reason: "new",
    nextSessionId: startEvent.sessionId,
    nextSessionKey: startEvent.sessionKey,
  });
  expect(startEvent.resumedFrom).toBe("sess-parent-hooks");
  expect(startEvent.sessionId).toBeTypeOf("string");
  expect(startEvent.sessionId).not.toBe("");
  const key = expectStringValue(startEvent.sessionKey, "created session key");
  expect(key).toMatch(/^agent:main:dashboard:[\s\S]+$/);
});

test("sessions.create waits for the parent run lifecycle before firing hooks", async () => {
  await createSessionStoreDir();
  await writeStoredSession("sess-active-parent");
  embeddedRunMock.activeIds.add("sess-active-parent");

  const result = await createFromMainSession({ key: "tui-next", emitCommandHooks: true });

  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "UNAVAILABLE" });
  expect(result.error?.message).toMatch(/parent session.*still active/i);
  expectNoCreationHooks();
});

test("sessions.create waits for the parent work admission to release", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeStoredSession("sess-finishing-parent");
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:main", "sess-finishing-parent"],
    assertAllowed: () => {},
  });
  try {
    const result = await createFromMainSession({ key: "tui-next", emitCommandHooks: true });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "UNAVAILABLE" });
    expect(commandHookEvents()).toHaveLength(0);
    expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
  } finally {
    admission.release();
  }
});

test("sessions.create fences new parent work while rollover hooks run", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeStoredSession("sess-parent-fenced");
  const hookEntered = createDeferred();
  const releaseHook = createDeferred();
  const admissionController = new AbortController();
  let admission: ReturnType<typeof beginSessionWorkAdmission> | undefined;
  sessionHookMocks.triggerInternalHook.mockImplementationOnce(async () => {
    hookEntered.resolve();
    await releaseHook.promise;
  });

  const creating = createFromMainSession({ key: "tui-next", emitCommandHooks: true });
  const settledWork: Promise<unknown>[] = [Promise.allSettled([creating])];
  let cleaningUp: Promise<void> | undefined;
  const cleanup = () => {
    releaseHook.resolve();
    admissionController.abort();
    return (cleaningUp ??= (async () => {
      const lease = await admission?.catch(() => undefined);
      lease?.release();
      await Promise.all(settledWork);
      sessionHookMocks.triggerInternalHook.mockReset();
    })());
  };
  pendingHookCleanups.add(cleanup);
  try {
    await Promise.race([
      hookEntered.promise,
      creating.then((result) => {
        throw new Error(
          `Session creation settled before its rollover hook: ${result.error?.message ?? "no hook"}`,
        );
      }),
    ]);
    admissionController.signal.throwIfAborted();
    expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);

    let admissionStarted = false;
    admission = beginSessionWorkAdmission({
      scope: storePath,
      identities: ["agent:main:main", "sess-parent-fenced"],
      signal: admissionController.signal,
      assertAllowed: () => {
        admissionStarted = true;
      },
    });
    settledWork.push(Promise.allSettled([admission]));
    await Promise.resolve();
    expect(admissionStarted).toBe(false);

    releaseHook.resolve();
    expect((await creating).ok).toBe(true);
    await admission;
    expect(admissionStarted).toBe(true);
  } finally {
    await cleanup();
    pendingHookCleanups.delete(cleanup);
  }
});

test("sessions.create with emitCommandHooks=true resets parent in place when session.dmScope is 'main' (#77434)", async () => {
  await createSessionStoreDir();
  await withMainDmScope(async () => {
    await writeStoredSession("sess-parent-dms", {
      content: "hello before /new",
    });
    embeddedRunMock.activeIds.add("sess-parent-dms");

    const result = await createFromMainSession({ emitCommandHooks: true });
    expect(result.ok).toBe(true);
    // Reset-in-place: response key matches the parent main key, NOT a dashboard child.
    expect(result.payload).toMatchObject({
      key: "agent:main:main",
      runStarted: false,
      sessionId: "sess-parent-dms",
    });
    const [endEvent, startEvent] = lifecycleEvents();
    expect(endEvent).toMatchObject({
      sessionId: "sess-parent-dms",
      sessionKey: "agent:main:main",
      reason: "new",
    });
    expect(startEvent).toMatchObject({
      sessionKey: "agent:main:main",
      resumedFrom: "sess-parent-dms",
    });
  });
});

test("sessions.create keeps an explicit TUI child key when session.dmScope is 'main'", async () => {
  await createSessionStoreDir();
  await withMainDmScope(async () => {
    await writeStoredSession("sess-parent-tui", {
      content: "hello before TUI /new",
    });

    const result = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
      key: "tui-explicit",
      agentId: "main",
      parentSessionKey: "main",
      emitCommandHooks: true,
    });

    expect(result.ok).toBe(true);
    expect(result.payload?.key).toBe("agent:main:tui-explicit");
    expect(result.payload?.sessionId).not.toBe("sess-parent-tui");
    expect(expectSingleCommandHookEvent("new").context?.commandSource).toBe("webchat");
    const [endEvent] = firstHookCall(sessionLifecycleHookMocks.runSessionEnd);
    const [startEvent] = firstHookCall(sessionLifecycleHookMocks.runSessionStart);
    expect(endEvent).toMatchObject({
      sessionKey: "agent:main:main",
      nextSessionKey: "agent:main:tui-explicit",
    });
    expect(startEvent.sessionKey).toBe("agent:main:tui-explicit");
  });
});

test("sessions.create without emitCommandHooks does not fire command:new hook (#76957)", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-parent2", "hello from parent 2");

  await writeStoredSession("sess-parent2");

  expect((await createFromMainSession()).ok).toBe(true);

  expectNoCreationHooks();
});

test("sessions.reset clears cli session bindings for parent-linked non-subagent sessions (e.g. dashboard children)", async () => {
  await createSessionStoreDir();
  await writeStoredSession("sess-dashboard-child", {
    key: "dashboard:child:42",
    ...claudeCliBindings("claude-cli-dashboard-session"),
    // Parent linkage alone does not make this a spawned subagent.
    parentSessionKey: "agent:main:main",
    content: "hello from dashboard child",
    messageId: "m-dashboard",
  });

  await resetSession("dashboard:child:42");

  const store = await loadGatewaySessionStoreForKey("dashboard:child:42");
  const nextEntry = store["agent:main:dashboard:child:42"];
  expect(nextEntry?.sessionId).toBe("sess-dashboard-child");
  for (const key of [
    "agentHarnessId",
    "claudeCliSessionId",
    "cliSessionBindings",
    "cliSessionIds",
  ] as const) {
    expect(nextEntry?.[key]).toBeUndefined();
  }
});

test("sessions.reset preserves cli session bindings for spawned subagents (Tak Hoffman's fa56682b3ced contract)", async () => {
  await createSessionStoreDir();
  const reseedPromptHash = "a".repeat(64);
  const childEntry = sessionStoreEntry("sess-spawned-child", {
    ...claudeCliBindings("claude-cli-child-session"),
    agentHarnessId: "codex",
    parentSessionKey: "agent:main:main",
    spawnedBy: "agent:main:main",
    subagentRole: "orchestrator",
  });
  childEntry.cliSessionBindings = {
    "claude-cli": {
      sessionId: "claude-cli-child-session",
      reseedReceipt: {
        version: 1,
        promptHash: reseedPromptHash,
        localSessionId: "sess-spawned-child",
        userTurnDisposition: "omitted",
      },
    },
  };

  await writeStoredSession("sess-spawned-child", {
    ...childEntry,
    key: "subagent:child",
    content: "hello from spawned child",
    messageId: "m-child",
  });

  await resetSession("subagent:child");

  const store = await loadGatewaySessionStoreForKey("subagent:child");
  const nextEntry = store["agent:main:subagent:child"];
  expect(nextEntry).toMatchObject({
    sessionId: "sess-spawned-child",
    claudeCliSessionId: "claude-cli-child-session",
  });
  expect(nextEntry?.agentHarnessId).toBeUndefined();
  expect(nextEntry?.cliSessionIds).toEqual({
    "claude-cli": "claude-cli-child-session",
  });
  expect(nextEntry?.cliSessionBindings).toEqual(childEntry.cliSessionBindings);
});
