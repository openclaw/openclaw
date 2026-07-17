// Timeout tests live separately so the broader reset-cleanup suite stays below
// the repository's per-file line limit as reset behaviors grow.
import { afterEach, expect, test, vi } from "vitest";
import {
  readAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  acpManagerMocks,
  acpRuntimeMocks,
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
  writeSingleLineSession,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
});

function installAcpRuntimeBackendWithFreshSession() {
  const prepareFreshSession = vi.fn(async () => {});
  acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
    id: "acpx",
    runtime: { prepareFreshSession },
  });
  return prepareFreshSession;
}

function resolvedAcpMeta(params: {
  recordId: string;
  backendSessionId: string;
}): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime:reset",
    identity: {
      state: "resolved",
      acpxRecordId: params.recordId,
      acpxSessionId: params.backendSessionId,
      source: "status",
      lastUpdatedAt: Date.now(),
    },
    mode: "persistent",
    runtimeOptions: {
      runtimeMode: "auto",
      timeoutSeconds: 30,
    },
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
    identity: {
      state: "pending",
      acpxRecordId: "agent:main:main",
    },
    mode: "persistent",
    runtimeOptions: {
      runtimeMode: "auto",
      timeoutSeconds: 30,
    },
    cwd: "/tmp/acp-session",
    state: "idle",
  });
  expect(acp?.identity?.acpxSessionId).toBeUndefined();
}

async function setupAcpSession(backendSessionId: string) {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  const prepareFreshSession = installAcpRuntimeBackendWithFreshSession();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:main",
    meta: resolvedAcpMeta({
      recordId: "agent:main:main",
      backendSessionId,
    }),
  });
  return prepareFreshSession;
}

async function resetMainSession() {
  return await directSessionReq<{ ok: true; key: string; entry: Record<string, unknown> }>(
    "sessions.reset",
    { key: "main" },
  );
}

async function resetAfterCleanupTimeout(operationStarted: Promise<void>) {
  const resetPromise = resetMainSession();
  await operationStarted;
  await vi.advanceTimersByTimeAsync(15_000);
  return await resetPromise;
}

function expectForceDiscarded(
  prepareFreshSession: ReturnType<typeof installAcpRuntimeBackendWithFreshSession>,
) {
  expect(acpManagerMocks.forceDiscardSession).toHaveBeenCalledTimes(1);
  const forceDiscardCall = acpManagerMocks.forceDiscardSession.mock.calls.at(0) as unknown as
    | [{ reason?: string; sessionKey?: string }]
    | undefined;
  expect(forceDiscardCall?.[0]).toMatchObject({
    reason: "session-reset",
    sessionKey: "agent:main:main",
  });
  expectResetAcpState(readAcpSessionMeta({ sessionKey: "agent:main:main" }));
  expect(prepareFreshSession).toHaveBeenCalledWith({ sessionKey: "agent:main:main" });
}

test("sessions.reset force-discards ACP runtime when cancel times out", async () => {
  vi.useFakeTimers();
  try {
    const prepareFreshSession = await setupAcpSession("backend-session-timeout");
    let markCancelStarted: (() => void) | undefined;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    // Hang cancel so the cleanup race times out; close must be skipped and the
    // manager force-discard path must run so the handle is not left reusable.
    acpManagerMocks.cancelSession.mockImplementation(() => {
      markCancelStarted?.();
      return new Promise(() => {});
    });

    expect((await resetAfterCleanupTimeout(cancelStarted)).ok).toBe(true);
    expect(acpManagerMocks.closeSession).not.toHaveBeenCalled();
    expectForceDiscarded(prepareFreshSession);
  } finally {
    acpManagerMocks.cancelSession.mockImplementation(async () => {});
  }
});

test("sessions.reset force-discards ACP runtime when close times out", async () => {
  vi.useFakeTimers();
  try {
    const prepareFreshSession = await setupAcpSession("backend-session-close-timeout");
    let markCloseStarted: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    // Cancel succeeds; hang close so cleanup times out and force-discard still
    // runs without waiting indefinitely on the stuck close.
    acpManagerMocks.cancelSession.mockImplementation(async () => {});
    acpManagerMocks.closeSession.mockImplementation(() => {
      markCloseStarted?.();
      return new Promise(() => {});
    });

    expect((await resetAfterCleanupTimeout(closeStarted)).ok).toBe(true);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalled();
    expect(acpManagerMocks.closeSession).toHaveBeenCalledTimes(1);
    expectForceDiscarded(prepareFreshSession);
  } finally {
    acpManagerMocks.cancelSession.mockImplementation(async () => {});
    acpManagerMocks.closeSession.mockImplementation(async () => {});
  }
});
