// ACP reset timeout regressions verify that stuck manager cleanup cannot poison
// the next runtime session or prevent reset from completing.
import { afterEach, expect, test, vi } from "vitest";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import {
  readAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import {
  acknowledgeSessionStateNotices,
  recordSessionStateEvent,
  registerSessionStateWatch,
} from "../sessions/session-state-events.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { onGatewaySessionReset } from "./session-reset-notifications.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  acpManagerMocks,
  acpRuntimeMocks,
  beforeResetHookMocks,
  beforeResetHookState,
  directSessionReq,
  sessionLifecycleHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
  threadBindingMocks,
  writeSingleLineSession,
} from "./test/server-sessions.test-helpers.js";

const {
  createSessionStoreDir,
  createConfiguredGlobalAgentSessionStore,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function resolvedAcpMeta(): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime:reset",
    identity: {
      state: "resolved",
      acpxRecordId: "agent:main:main",
      acpxSessionId: "backend-session-1",
      source: "status",
      lastUpdatedAt: Date.now(),
    },
    mode: "persistent",
    runtimeOptions: { runtimeMode: "auto", timeoutSeconds: 30 },
    cwd: "/tmp/acp-session",
    state: "idle",
    lastActivityAt: Date.now(),
  };
}

function expectResetAcpState(acp: SessionAcpMeta | undefined) {
  expect(acp).toMatchObject({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime:reset",
    identity: { state: "pending", acpxRecordId: "agent:main:main" },
    mode: "persistent",
    runtimeOptions: { runtimeMode: "auto", timeoutSeconds: 30 },
    cwd: "/tmp/acp-session",
    state: "idle",
  });
  expect(acp?.identity?.acpxSessionId).toBeUndefined();
}

function accelerateAcpCleanupTimeout() {
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  return vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => nativeSetTimeout(callback, delay === 15_000 ? 0 : delay, ...args)) as typeof setTimeout);
}

async function seedAcpSession() {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:main",
    meta: resolvedAcpMeta(),
  });
  const prepareFreshSession = vi.fn(async () => {});
  acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
    id: "acpx",
    runtime: { prepareFreshSession },
  });
  return { prepareFreshSession, storePath };
}

test.each(["source", "source-and-acp", "acp", "committed-callback"])(
  "settles committed reset actions after %s failure",
  async (failure) => {
    const { prepareFreshSession, storePath } = await seedAcpSession();
    const sessionKey = "agent:main:main";
    const childKey = "agent:main:subagent:watched";
    const previous = loadSessionEntry({ storePath, sessionKey });
    const sourceFails = failure === "source" || failure === "source-and-acp";
    const postCommitFails = failure === "acp" || failure === "source-and-acp";
    const committedCallbackFails = failure === "committed-callback";
    const sourceFailure = new Error("project source cleanup failed");
    const committedCallbackFailure = new Error("committed callback failed");
    const postCommitFailure = new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "owner repair required",
      {
        detailCode: "SESSION_OWNER_MIGRATION_REQUIRED",
      },
    );
    const events: string[] = [];
    const notified = vi.fn();
    const unsubscribeReset = onGatewaySessionReset(notified);
    const rollback = vi.fn(async () => {});
    const recordChildActivity = () =>
      recordSessionStateEvent({
        sessionKey: childKey,
        agentId: "main",
        kind: "human_direct_message",
        actorType: "human",
        summary: "human message via test",
      });
    expect(
      registerSessionStateWatch({ watcherSessionKey: sessionKey, targetSessionKey: childKey }),
    ).toBe(true);
    recordChildActivity();
    expect(drainSystemEvents(sessionKey)).toHaveLength(1);
    acknowledgeSessionStateNotices(sessionKey, [childKey]);
    prepareFreshSession.mockImplementation(async () => {
      events.push("runtime-preparation");
      if (postCommitFails) {
        throw postCommitFailure;
      }
    });
    beforeResetHookState.hasBeforeResetHook = true;
    if (!postCommitFails) {
      beforeResetHookMocks.runBeforeReset.mockImplementationOnce(async () => {
        events.push("before-reset");
      });
    }
    const { performGatewaySessionReset } = await import("./session-reset-service.js");

    const reset = performGatewaySessionReset({
      key: "main",
      reason: "reset",
      commandSource: "gateway:sessions.reset",
      workerPlacementContext: {},
      onCommitted: () => {
        events.push("committed");
        if (committedCallbackFails) {
          throw committedCallbackFailure;
        }
      },
      prepareLifecycle: async () => ({
        ok: true,
        value: {
          rollback,
          withCommit: async (run) => {
            const result = await run(() => {});
            events.push("source-closed");
            if (sourceFails) {
              throw sourceFailure;
            }
            return result;
          },
        },
      }),
    });
    try {
      if (sourceFails && postCommitFails) {
        await expect(reset).rejects.toMatchObject({
          errors: [sourceFailure, postCommitFailure],
          cause: postCommitFailure,
        });
      } else {
        await expect(reset).rejects.toBe(
          sourceFails
            ? sourceFailure
            : committedCallbackFails
              ? committedCallbackFailure
              : postCommitFailure,
        );
      }
    } finally {
      unsubscribeReset();
    }

    expect(notified).toHaveBeenCalledExactlyOnceWith(sessionKey, "main");
    recordChildActivity();
    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledExactlyOnceWith({
      targetSessionKey: sessionKey,
      reason: "session-reset",
    });
    expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(sessionLifecycleHookMocks.runSessionStart).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "committed",
      ...(committedCallbackFails ? [] : ["source-closed"]),
      "runtime-preparation",
      ...(postCommitFails ? [] : ["before-reset"]),
    ]);
    expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(postCommitFails ? 0 : 1);
    expect(rollback).not.toHaveBeenCalled();
    const current = loadSessionEntry({ storePath, sessionKey });
    expect(current?.lifecycleRevision).toEqual(expect.any(String));
    expect(current?.lifecycleRevision).not.toBe(previous?.lifecycleRevision);
    expectResetAcpState(readAcpSessionMeta({ sessionKey: "agent:main:main" }));
  },
);

test("sessions.reset force-discards ACP runtime ownership after cancel timeout", async () => {
  const { prepareFreshSession, storePath } = await seedAcpSession();
  let releaseCancel: (() => void) | undefined;
  acpManagerMocks.cancelSession.mockImplementation(
    async () =>
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      }),
  );
  const timeoutSpy = accelerateAcpCleanupTimeout();

  try {
    const reset = await directSessionReq<{ ok: true }>("sessions.reset", { key: "main" });
    expect(reset.ok).toBe(true);
    expect(acpManagerMocks.forceDiscardSessionRuntime).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      sessionKey: "agent:main:main",
      reason: "session-reset",
      agentId: "main",
      isCurrent: expect.any(Function),
      assertCurrent: undefined,
    });
    expect(acpManagerMocks.closeSession).not.toHaveBeenCalled();
    expect(prepareFreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:main", agentId: "main" }),
    );
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })).not.toHaveProperty(
      "acp",
    );
    expectResetAcpState(readAcpSessionMeta({ sessionKey: "agent:main:main" }));
  } finally {
    releaseCancel?.();
    timeoutSpy.mockRestore();
    acpManagerMocks.cancelSession.mockImplementation(async () => {});
  }
});

test("sessions.reset force-discards ACP actor ownership after close timeout", async () => {
  const { prepareFreshSession } = await seedAcpSession();
  let releaseClose: (() => void) | undefined;
  acpManagerMocks.closeSession.mockImplementation(
    async () =>
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      }),
  );
  const timeoutSpy = accelerateAcpCleanupTimeout();

  try {
    const reset = await directSessionReq<{ ok: true }>("sessions.reset", { key: "main" });
    expect(reset.ok).toBe(true);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledTimes(1);
    expect(acpManagerMocks.closeSession).toHaveBeenCalledTimes(1);
    expect(acpManagerMocks.forceDiscardSessionRuntime).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      sessionKey: "agent:main:main",
      reason: "session-reset",
      agentId: "main",
      isCurrent: expect.any(Function),
      assertCurrent: undefined,
    });
    expect(prepareFreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:main", agentId: "main" }),
    );
    expectResetAcpState(readAcpSessionMeta({ sessionKey: "agent:main:main" }));
  } finally {
    releaseClose?.();
    timeoutSpy.mockRestore();
    acpManagerMocks.closeSession.mockImplementation(async () => {});
  }
});

test.each([true, false])(
  "reset binds legacy ACP metadata to the committed canonical row (existing=%s)",
  async (existing) => {
    const { storePath } = await createSessionStoreDir();
    await writeSessionStore({
      entries: existing ? { main: sessionStoreEntry("legacy-main") } : {},
    });
    const { identity: _identity, ...legacyMeta } = resolvedAcpMeta();
    writeAcpSessionMetaForMigration({ sessionKey: "agent:main:main", meta: legacyMeta });
    const reset = await directSessionReq("sessions.reset", { key: "main" });
    expect(reset.ok).toBe(true);
    const entry = loadSessionEntry({ storePath, sessionKey: "agent:main:main" });
    expect(entry?.lifecycleRevision).toEqual(expect.any(String));
    const meta = readAcpSessionMeta({ sessionKey: "agent:main:main", agentId: "main" });
    expect(meta).toMatchObject({ backend: "acpx", agent: "codex", identity: { state: "pending" } });
    expect(loadSessionEntry({ storePath, sessionKey: "main" })?.sessionId).toBe(entry?.sessionId);
  },
);

test.each(["global", "agent:work:main"])(
  "reset of %s preserves the other agent's ACP owner",
  async (key) => {
    const stores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });
    try {
      const cfg = stores.getRuntimeConfig();
      const mainMeta = { ...resolvedAcpMeta(), runtimeSessionName: "main-owned" };
      const workMeta = { ...resolvedAcpMeta(), runtimeSessionName: "work-owned" };
      writeAcpSessionMetaForMigration({
        sessionKey: buildAcpDatabaseSessionKey("global", "main"),
        meta: mainMeta,
      });
      writeAcpSessionMetaForMigration({
        sessionKey: buildAcpDatabaseSessionKey("global", "work"),
        meta: workMeta,
      });
      const before = readAcpSessionMeta({ cfg, sessionKey: "global", agentId: "main" });
      const reset = await directSessionReq("sessions.reset", { key, agentId: "work" });
      expect(reset.ok).toBe(true);
      expect(readAcpSessionMeta({ cfg, sessionKey: "global", agentId: "main" })).toEqual(before);
      expect(readAcpSessionMeta({ cfg, sessionKey: "global", agentId: "work" })).toMatchObject({
        runtimeSessionName: "work-owned",
        identity: { state: "pending" },
      });
      expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "work" }),
      );
    } finally {
      await resetConfiguredGlobalAgentSessionStore(stores);
    }
  },
);

test.each(["owner-repair", "discard-error"] as const)(
  "reset does not commit when cleanup fails with %s",
  async (failure) => {
    const { storePath } = await seedAcpSession();
    const before = loadSessionEntry({ storePath, sessionKey: "agent:main:main" });
    const error =
      failure === "owner-repair"
        ? new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "owner repair required", {
            detailCode: "SESSION_OWNER_MIGRATION_REQUIRED",
          })
        : new Error("force discard failed");
    const timeoutSpy = accelerateAcpCleanupTimeout();
    let release: (() => void) | undefined;
    try {
      if (failure === "owner-repair") {
        acpManagerMocks.cancelSession.mockRejectedValueOnce(error);
      } else {
        acpManagerMocks.cancelSession.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
        acpManagerMocks.forceDiscardSessionRuntime.mockRejectedValueOnce(error);
      }
      const { performGatewaySessionReset } = await import("./session-reset-service.js");
      const pending = performGatewaySessionReset({
        key: "main",
        reason: "reset",
        commandSource: "gateway:sessions.reset",
        workerPlacementContext: {},
      });
      if (failure === "discard-error") {
        await expect(pending).rejects.toThrow("force discard failed");
      } else {
        expect((await pending).ok).toBe(false);
      }
      expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })).toEqual(before);
    } finally {
      release?.();
      timeoutSpy.mockRestore();
    }
  },
);
