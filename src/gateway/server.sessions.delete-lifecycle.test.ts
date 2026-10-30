import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type {
  SessionsDeleteParams,
  SessionsDeleteResult,
} from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { CronJob, CronStoredJob } from "../cron/types.js";
import { readAttachedSessionEndTranscriptSourceForTest } from "../plugins/session-end-transcript.test-support.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  readSessionControllerAdmissionError,
  runSessionMutation,
} from "../sessions/session-controller.lifecycle.js";
import {
  submitSessionControllerTask,
  releaseSessionControllerClaim,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { deleteIncognitoSessionForReset } from "./session-reset-incognito.js";
import { embeddedRunMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  subagentLifecycleHookMocks,
  threadBindingMocks,
  acpManagerMocks,
  browserSessionTabMocks,
  bundleMcpRuntimeMocks,
  sessionLifecycleHookMocks,
  writeSingleLineSession,
  sessionStoreEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerInferenceDrainService } from "./worker-environments/inference-control.test-helpers.js";

const {
  createConfiguredGlobalAgentSessionStore,
  createSessionStoreDir,
  openClient,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsTestHarness();
const { closeTrackedBrowserTabsForSessions: closeTabs } = browserSessionTabMocks;
const { disposeSessionMcpRuntime: disposeRuntime, retireSessionMcpRuntime: retireRuntime } =
  bundleMcpRuntimeMocks;
const { unbindThreadBindingsBySessionKey: unbind } = threadBindingMocks;

function deleteSession(
  request: SessionsDeleteParams,
  options?: Parameters<typeof directSessionReq<SessionsDeleteResult>>[2],
) {
  return directSessionReq<SessionsDeleteResult>("sessions.delete", request, options);
}

async function expectSessionDeleteSucceeds(request: SessionsDeleteParams) {
  const deleted = await deleteSession(request);
  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
}

function expectRejection(
  result: { ok: boolean; error?: unknown },
  message: unknown,
  code?: string,
) {
  expect(result).toMatchObject({
    ok: false,
    error: { message, ...(code ? { code } : {}) },
  });
}

async function expectSessionDeleteChanged(request: SessionsDeleteParams) {
  const deleted = await deleteSession(request);
  expectRejection(deleted, `Session ${request.key} changed before deletion. Retry.`);
  expect(deleted.error?.details).toEqual({ reason: "session-changed" });
}

async function seedSessions(
  ...sessions: Array<[key: string, id: string, options?: Partial<SessionEntry>]>
) {
  const store = await createSessionStoreDir();
  const entries: Record<string, SessionEntry> = {};
  for (const [key, id, options] of sessions) {
    entries[key] = sessionStoreEntry(id, options);
    await writeSingleLineSession(store.dir, id, id);
  }
  await writeSessionStore({ entries });
  return store;
}

async function seedSession(
  key = "agent:main:subagent:worker",
  id = "sess-subagent",
  options: Partial<SessionEntry> = {},
) {
  const store = await createSessionStoreDir();
  const storePath = options.incognito
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" })
    : store.storePath;
  const target = { agentId: "main", storePath, sessionKey: key };
  const entry = sessionStoreEntry(id, options);
  const write = (nextId = id, changes: Partial<SessionEntry> = {}) => {
    const updated = { ...entry, sessionId: nextId, ...changes };
    return options.incognito
      ? replaceSessionEntry(target, updated)
      : writeSessionStore({ entries: { [key]: updated } });
  };
  await write();
  return { storePath, key, id, target, entry, write, read: () => loadSessionEntry(target) };
}

function seedIncognito(kind: string, options: Partial<SessionEntry> = {}) {
  return seedSession(`agent:main:dashboard:incognito-${kind}-composition`, `${kind}-composition`, {
    incognito: true,
    lifecycleRevision: "initial",
    updatedAt: 1,
    ...options,
  });
}

function lifecycleHold<T>(result: T) {
  const entered = createDeferred();
  const released = createDeferred();
  return {
    started: entered.promise,
    release: released.resolve,
    run: async () => {
      entered.resolve();
      await released.promise;
      return result;
    },
  };
}

test("sessions.delete protects the sole explicit agent's global session before cleanup", async () => {
  testState.agentsConfig = { ownership: "explicit", entries: { ops: {} } };
  testState.sessionConfig = { scope: "global" };
  const { storePath } = await createSessionStoreDir();
  const target = { agentId: "ops", sessionKey: "global", storePath };
  await replaceSessionEntry(target, sessionStoreEntry("sole-global"));
  const before = loadSessionEntry(target);
  embeddedRunMock.activeIds.add("sole-global");
  embeddedRunMock.waitResults.set("sole-global", true);
  const result = await deleteSession({ key: "global", agentId: "ops" });
  expectRejection(result, "Cannot delete the main session (global).");
  expect(loadSessionEntry(target)).toEqual(before);
  expect(embeddedRunMock.abortCalls).not.toContain("sole-global");
  expect(disposeRuntime).not.toHaveBeenCalled();
  expect(closeTabs).not.toHaveBeenCalled();
});

test("sessions.delete rejects main and aborts active runs", async () => {
  const key = "agent:main:discord:group:dev";
  const reason = "session-delete";
  const { storePath } = await seedSessions(
    ["main", "sess-main"],
    ["discord:group:dev", "sess-active"],
  );
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey: "agent:main:discord:group:dev",
    aliases: ["discord:group:dev", "sess-active"],
    incarnation: "sess-active",
    agentId: "main",
  });
  const started = createDeferred();
  let interrupted = false;
  const activeRun = withSessionTurn(
    { sessionKey: target.sessionKey, sessionId: "sess-active", target },
    async (_operation, signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          interrupted = true;
          resolve();
        });
      });
    },
  );
  await started.promise;
  const mainDelete = await deleteSession({ key: "main" });
  expect(mainDelete.ok).toBe(false);
  await expectSessionDeleteSucceeds({ key: "discord:group:dev" });
  await activeRun;
  expect(interrupted).toBe(true);
  expect(embeddedRunMock.abortCalls).not.toContain("sess-active");
  expect(disposeRuntime).toHaveBeenCalledWith("sess-active");
  expect(closeTabs).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sessionKeys: [key, "agent:main:sess-active"],
      onWarn: expect.any(Function),
    }),
  );
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledExactlyOnceWith(
    { targetSessionKey: key, targetKind: "acp", reason, sendFarewell: true, outcome: "deleted" },
    { childSessionKey: key },
  );
  expect(unbind).toHaveBeenCalledExactlyOnceWith({ targetSessionKey: key, reason });
});

test("sessions.delete reports bound automation cleanup for both authorized deletion paths", async () => {
  const archivedKey = "agent:main:archived-context";
  const adminKey = "agent:main:admin-context";
  const unrelatedKey = "agent:main:other";
  await seedSessions(
    [archivedKey, "sess-archived", { archivedAt: Date.now() }],
    [adminKey, "sess-admin"],
    [unrelatedKey, "sess-other"],
  );
  const job = (id: string, sessionKey: string, ownerSessionId: string): CronStoredJob => ({
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "at", at: "2027-01-01T00:00:00.000Z" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "Synthetic reminder with copied context" },
    owner: { agentId: "main", sessionKey },
    ownerSessionId,
    state: {},
  });
  const jobs = [
    job("archived-bound", archivedKey, "sess-archived"),
    job("admin-bound", adminKey, "sess-admin"),
    job("fails", adminKey, "sess-admin"),
    job("unrelated", unrelatedKey, "sess-other"),
    job("old-incarnation", adminKey, "sess-old"),
  ];
  const updateWithPrecondition = vi.fn(
    async (
      id: string,
      patch: { enabled?: boolean },
      precondition: (currentJob: CronJob, nowMs: number) => void | Promise<void>,
    ) => {
      const currentJob = jobs.find((candidate) => candidate.id === id);
      if (!currentJob) {
        throw new Error(`cron job not found: ${id}`);
      }
      if (id === "fails") {
        throw new Error("synthetic disable failure");
      }
      await precondition(currentJob, Date.now());
      currentJob.enabled = patch.enabled ?? currentJob.enabled;
      return currentJob;
    },
  );
  const context = {
    cron: {
      getDefaultAgentId: () => "main",
      list: async () => jobs,
      updateWithPrecondition,
    },
  };
  const writeScopedClient = { connect: { scopes: ["operator.write"] } } as never;
  const archivedDeleted = await deleteSession(
    { key: archivedKey, archivedOnly: true },
    { context, client: writeScopedClient },
  );
  expect(archivedDeleted).toMatchObject({
    ok: true,
    payload: {
      deleted: true,
      automationCleanup: { disabledJobIds: ["archived-bound"], failures: [] },
    },
  });

  const deleted = await deleteSession(
    { key: adminKey },
    { context, client: { connect: { scopes: ["operator.admin"] } } as never },
  );

  expect(deleted).toMatchObject({
    ok: true,
    payload: {
      deleted: true,
      automationCleanup: {
        disabledJobIds: ["admin-bound"],
        failures: [{ jobId: "fails", message: "synthetic disable failure" }],
      },
    },
  });
  expect(jobs.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
    { id: "archived-bound", enabled: false },
    { id: "admin-bound", enabled: false },
    { id: "fails", enabled: true },
    { id: "unrelated", enabled: true },
    { id: "old-incarnation", enabled: true },
  ]);
});

test("sessions.delete preserves locked archived sessions and deletes ordinary archived sessions", async () => {
  const lockedKey = "agent:main:harness:codex:supervision:native-thread";
  const ordinaryKey = "agent:main:ordinary-archived";
  const lockedSessionId = "sess-locked-archived";
  const ordinarySessionId = "sess-ordinary-archived";
  const archivedAt = Date.now();
  const locked = { agentHarnessId: "codex", archivedAt, modelSelectionLocked: true };
  const { dir, storePath } = await seedSessions(
    [lockedKey, lockedSessionId, locked],
    [ordinaryKey, ordinarySessionId, { archivedAt }],
  );
  const lockedEntryBefore = structuredClone(loadSessionEntry({ storePath, sessionKey: lockedKey }));
  const lockedTranscriptPath = path.join(dir, `${lockedSessionId}.jsonl`);
  const lockedTranscriptBefore = await fs.readFile(lockedTranscriptPath, "utf8");
  const rejected = await deleteSession({ key: lockedKey, archivedOnly: true });
  expectRejection(
    rejected,
    "This session cannot be deleted while model selection is locked.",
    "INVALID_REQUEST",
  );
  expect(loadSessionEntry({ storePath, sessionKey: lockedKey })).toEqual(lockedEntryBefore);
  expect(await fs.readFile(lockedTranscriptPath, "utf8")).toBe(lockedTranscriptBefore);
  await expectSessionDeleteSucceeds({ key: ordinaryKey, archivedOnly: true });
  expect(loadSessionEntry({ storePath, sessionKey: ordinaryKey })).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: lockedKey })).toEqual(lockedEntryBefore);
});

test("sessions.delete removes a locked plugin-owned session from its persisted alias", async () => {
  const key = "agent:main:catalog-owned";
  const alias = "catalog-owned";
  const ids = ["sess-catalog-owned-canonical", "sess-catalog-owned-alias"] as const;
  const owner = { modelSelectionLocked: true, pluginOwnerId: "anthropic" };
  const { storePath } = await seedSession(key, ids[0], { ...owner, updatedAt: 2 });
  await replaceSessionEntry(
    { agentId: "main", sessionKey: alias, storePath },
    sessionStoreEntry(ids[1], { ...owner, updatedAt: 1 }),
  );
  for (const sessionId of ids) {
    await replaceTranscriptEvents({ sessionKey: key, sessionId, storePath }, [
      { type: "session", id: sessionId, content: sessionId },
      {
        type: "message",
        id: `${sessionId}-message`,
        parentId: null,
        message: { role: "user", content: `content for ${sessionId}` },
      },
    ]);
  }
  const deleted = await deleteSession({ key: alias });
  expect(deleted.ok).toBe(true);
  for (const sessionKey of [key, alias]) {
    expect(loadSessionEntry({ storePath, sessionKey })).toBeUndefined();
  }
  expect(deleted.payload?.archived).toEqual(
    expect.arrayContaining(ids.map((id) => expect.stringContaining(`${id}.jsonl.deleted.`))),
  );
  for (const sessionId of ids) {
    await expect(loadTranscriptEvents({ sessionKey: key, sessionId, storePath })).resolves.toEqual(
      [],
    );
  }
  const endCall = sessionLifecycleHookMocks.runSessionEnd.mock.calls.at(0);
  assert(endCall, "expected session_end hook call");
  const [event, context] = endCall;
  const transcript = readAttachedSessionEndTranscriptSourceForTest(context);
  assert(transcript.available && event?.sessionId, "expected archived ended transcript source");
  const tail = await transcript.readTail({ maxMessages: 10, maxBytes: 65_536 });
  expect(tail).toMatchObject({
    messages: [
      expect.objectContaining({ role: "user", content: `content for ${event.sessionId}` }),
    ],
    totalMessages: 1,
    truncated: false,
  });
});

test("sessions.delete interrupts work admitted before runtime registration", async () => {
  const session = await seedSession();
  let interrupted = false;
  let releaseAdmission = () => {};
  const admission = await beginSessionEffect({
    scope: session.storePath,
    identities: [session.key, session.id],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
      releaseAdmission();
    },
  });
  releaseAdmission = admission.release;

  await expectSessionDeleteSucceeds({ key: session.key });
  expect(interrupted).toBe(true);
});

test.each(["session id", "updated at"] as const)(
  "sessions.delete rechecks expected %s before interrupting replacement work",
  async (guard) => {
    const session = await seedSession(undefined, "sess-original", {
      updatedAt: 1,
      lifecycleRevision: "same-lifecycle",
    });
    const replacementId = guard === "session id" ? "sess-replacement" : session.id;
    const interrupted = vi.fn();
    const replacementAdmission = await beginSessionEffect({
      scope: session.storePath,
      identities: [session.key, replacementId],
      assertAllowed: () => {},
      onInterrupt: interrupted,
    });
    const hold = lifecycleHold(undefined);
    const blockingMutation = runSessionMutation({
      scope: session.storePath,
      identities: [session.key],
      run: hold.run,
    });
    await hold.started;
    const deletion = deleteSession({
      key: session.key,
      expectedSessionId: session.id,
      ...(guard === "updated at" ? { expectedSessionUpdatedAt: 1 } : {}),
    });
    await Promise.resolve();
    await session.write(replacementId, { updatedAt: 2 });
    hold.release();
    try {
      const [deleted] = await Promise.all([deletion, blockingMutation]);
      expect(deleted.ok).toBe(false);
      expect(interrupted).not.toHaveBeenCalled();
    } finally {
      replacementAdmission.release();
    }
  },
);

test("sessions.delete rejects a replacement with the same updated-at timestamp", async () => {
  const updatedAt = 1_737_600_000_000;
  const session = await seedSession("agent:main:cron:cleanup", "replacement-run", {
    lifecycleRevision: "replacement-revision",
    updatedAt,
  });
  const interrupted = vi.fn();
  const admission = await beginSessionEffect({
    scope: session.storePath,
    identities: [session.key, session.id],
    assertAllowed: () => {},
    onInterrupt: interrupted,
  });
  try {
    await expectSessionDeleteChanged({
      key: session.key,
      expectedSessionId: "stale-run",
      expectedLifecycleRevision: "stale-revision",
      expectedSessionUpdatedAt: updatedAt,
    });
    expect(interrupted).not.toHaveBeenCalled();
    expect(session.read()).toMatchObject({
      lifecycleRevision: "replacement-revision",
      sessionId: "replacement-run",
      updatedAt,
    });
  } finally {
    admission.release();
  }
});

test.each(["controller cancellation", "cleanup"] as const)(
  "sessions.delete rejects a same-key successor created during %s without a caller identity guard",
  async (phase) => {
    const session = await seedSession("agent:main:cleanup-successor", "original-session");
    const replace = () => {
      replaceSessionEntrySync(session.target, sessionStoreEntry("successor-session"));
    };
    let releaseAdmission = () => {};
    if (phase === "controller cancellation") {
      const admission = await beginSessionEffect({
        scope: session.storePath,
        identities: [session.key, session.id],
        assertAllowed: () => {},
        onInterrupt: () => {
          try {
            replace();
          } finally {
            releaseAdmission();
          }
        },
      });
      releaseAdmission = admission.release;
    } else {
      disposeRuntime.mockImplementationOnce(async () => replace());
    }
    try {
      await expectSessionDeleteChanged({ key: session.key });
      expect(session.read()?.sessionId).toBe("successor-session");
      if (phase === "controller cancellation") {
        expect(disposeRuntime).not.toHaveBeenCalled();
      }
    } finally {
      releaseAdmission();
    }
  },
);

test("sessions.delete includes cleanup-owned row changes and saved snapshots in its guarded deletion", async () => {
  const lifecycleRevision = "cleanup-revision";
  const updatedAt = 1_737_600_000_000;
  const session = await seedSession("agent:main:cron:cleanup", "sess-cleanup", {
    lifecycleRevision,
    updatedAt,
    skillsSnapshot: { prompt: "Saved cleanup context", skills: [] },
  });
  disposeRuntime.mockImplementationOnce(async () => {
    await session.write(undefined, {
      label: "cleanup-owned revision",
      updatedAt: updatedAt + 1,
    });
  });
  await expectSessionDeleteSucceeds({
    key: session.key,
    expectedSessionId: session.id,
    expectedLifecycleRevision: lifecycleRevision,
    expectedSessionUpdatedAt: updatedAt,
  });
  expect(session.read()).toBeUndefined();
});

test("sessions.delete serializes a patch behind asynchronous runtime cleanup", async () => {
  const patchPreparation = await import("./server-methods/sessions-patch-expectations.js");
  const updatedAt = 1_737_600_000_000;
  const session = await seedSession(undefined, undefined, { updatedAt });
  const hold = lifecycleHold(undefined);
  disposeRuntime.mockImplementationOnce(hold.run);
  const deletion = deleteSession({
    key: session.key,
    expectedSessionId: session.id,
    expectedSessionUpdatedAt: updatedAt,
  });
  await hold.started;
  let patchSettled = false;
  const patchPreflight = createDeferred();
  const prepareTargets = patchPreparation.prepareSessionPatchTargets;
  // Placement reads also run during fixture initialization, before patch captures its target.
  const preflight = vi
    .spyOn(patchPreparation, "prepareSessionPatchTargets")
    .mockImplementation((input) => {
      const prepared = prepareTargets(input);
      patchPreflight.resolve();
      return prepared;
    });
  const patch = directSessionReq("sessions.patch", {
    key: session.key,
    label: "updated during cleanup",
  }).then((result) => {
    patchSettled = true;
    return result;
  });
  try {
    await patchPreflight.promise;
    expect(patchSettled).toBe(false);
    hold.release();
    const [deleted, patched] = await Promise.all([deletion, patch]);
    expect(deleted.ok).toBe(true);
    expectRejection(patched, `Session ${session.key} changed before patch. Retry.`);
    expect(session.read()).toBeUndefined();
  } finally {
    hold.release();
    await Promise.allSettled([deletion, patch]);
    preflight.mockRestore();
  }
});

test("sessions.patch waits for an in-flight session lifecycle mutation", async () => {
  const session = await seedSession();
  const hold = lifecycleHold(undefined);
  const mutation = runSessionMutation({
    scope: session.storePath,
    identities: [session.key, session.id],
    run: hold.run,
  });
  await hold.started;
  let patchSettled = false;
  const patch = directSessionReq("sessions.patch", {
    key: session.key,
    label: "after lifecycle mutation",
  }).then((result) => {
    patchSettled = true;
    return result;
  });
  await Promise.resolve();
  expect(patchSettled).toBe(false);
  hold.release();
  const [patched] = await Promise.all([patch, mutation]);
  expect(patched.ok).toBe(true);
  expect(session.read()?.label).toBe("after lifecycle mutation");
});

test("sessions.delete keeps lifecycle admission blocked through session unbinding", async () => {
  const session = await seedSession();
  const hold = lifecycleHold([]);
  unbind.mockImplementationOnce(hold.run);
  const releaseDrain = vi.fn();
  const workerEnvironmentService = createWorkerInferenceDrainService(() => ({
    drained: Promise.resolve(),
    hasWork: () => false,
    release: releaseDrain,
  }));
  const deletion = deleteSession({ key: session.key }, { context: { workerEnvironmentService } });
  await hold.started;
  let replacementAdmitted = false;
  const replacement = beginSessionEffect({
    scope: session.storePath,
    identities: [session.key, session.id],
    assertAllowed: () => {
      expect(releaseDrain).toHaveBeenCalled();
    },
  }).then((lease) => {
    replacementAdmitted = true;
    return lease;
  });
  await Promise.resolve();
  expect(replacementAdmitted).toBe(false);
  hold.release();
  const [deleted, replacementAdmission] = await Promise.all([deletion, replacement]);
  try {
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(replacementAdmitted).toBe(true);
  } finally {
    replacementAdmission.release();
  }
});

test("sessions.delete limits plugin-runtime cleanup to sessions owned by that plugin", async () => {
  const ownedKey = "agent:main:dreaming-narrative-owned";
  const foreignKey = "agent:main:dreaming-narrative-foreign";
  const { storePath } = await seedSessions(
    [ownedKey, "sess-owned", { pluginOwnerId: "memory-core" }],
    [foreignKey, "sess-foreign", { pluginOwnerId: "other-plugin" }],
  );

  const pluginClient = {
    connect: { scopes: ["operator.admin"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;
  const interrupted = vi.fn();
  const foreignAdmission = await beginSessionEffect({
    scope: storePath,
    identities: [foreignKey, "sess-foreign"],
    assertAllowed: () => {},
    onInterrupt: interrupted,
  });

  try {
    const denied = await deleteSession({ key: foreignKey }, { client: pluginClient });
    expectRejection(denied, expect.stringContaining("did not create it"));
    expect(interrupted).not.toHaveBeenCalled();
  } finally {
    foreignAdmission.release();
  }

  const deleted = await deleteSession({ key: ownedKey }, { client: pluginClient });
  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
});

test.each(["sessions.delete", "sessions.reset"] as const)(
  "%s scopes selected global cleanup to the requested agent",
  async (method) => {
    const stores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });
    const mainTarget = { agentId: "main", sessionKey: "global", storePath: stores.mainStorePath };
    const workTarget = { ...mainTarget, agentId: "work", storePath: stores.workStorePath };
    for (const target of [mainTarget, workTarget]) {
      await replaceSessionEntry(
        target,
        sessionStoreEntry(`sess-${target.agentId}-global`, {
          pluginExtensions: { fixture: { state: { owner: target.agentId } } },
        }),
      );
    }
    const mainBefore = loadSessionEntry(mainTarget);
    const { ws } = await openClient();
    try {
      const result = await rpcReq(ws, method, {
        key: "global",
        agentId: "work",
        ...(method === "sessions.delete" ? { deleteTranscript: false } : {}),
      });
      expect(result.ok, result.error?.message).toBe(true);
      expect(loadSessionEntry(mainTarget)).toEqual(mainBefore);
      const workAfter = loadSessionEntry(workTarget);
      if (method === "sessions.delete") {
        expect(workAfter).toBeUndefined();
      } else {
        expect(workAfter?.sessionId).toBe("sess-work-global");
        expect(workAfter?.pluginExtensions).toBeUndefined();
      }
    } finally {
      ws.close();
      await resetConfiguredGlobalAgentSessionStore(stores);
    }
  },
);

test("sessions.delete closes child ACP runtimes spawned from the deleted parent", async () => {
  const parentKey = "agent:main:acp-parent";
  const childKey = "agent:main:acp-child";
  const acpMeta = (recordId: string) => ({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: `runtime:${recordId}`,
    mode: "oneshot" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  });

  await seedSessions(
    ["main", "sess-main"],
    ["acp-parent", "sess-parent"],
    ["acp-child", "sess-child", { spawnedBy: parentKey }],
  );
  for (const sessionKey of [parentKey, childKey]) {
    seedCanonicalAcpSessionMeta({ sessionKey, meta: acpMeta(sessionKey) });
  }
  await expectSessionDeleteSucceeds({ key: "acp-parent" });

  // Both runtimes must close, otherwise the child's ACP process is orphaned (#68916).
  const closedKeys = (
    acpManagerMocks.closeSession.mock.calls as unknown as Array<[{ sessionKey?: string }]>
  ).map((call) => call[0]?.sessionKey);
  expect(closedKeys).toEqual(expect.arrayContaining([parentKey, childKey]));
  for (const sessionKey of [parentKey, childKey]) {
    expect(readAcpSessionEntry({ sessionKey })?.acp).toBeUndefined();
  }
});

test("sessions.delete returns unavailable when active run does not stop", async ({ signal }) => {
  const { dir, storePath } = await seedSessions(["discord:group:dev", "sess-active"]);
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey: "agent:main:discord:group:dev",
    aliases: ["discord:group:dev", "sess-active"],
    incarnation: "sess-active",
    agentId: "main",
  });
  const claim = await submitSessionControllerTask(target.sessionKey, {
    target,
    start: (mailboxClaim) => {
      createReplyOperation({
        sessionKey: target.sessionKey,
        sessionId: "sess-active",
        target,
        resetTriggered: false,
        mailboxClaim,
      });
    },
  });
  const operation = claim.operation!;
  const preemptAttempted = createDeferred();
  const deadlineArmed = createDeferred();
  let restoreDeadlineObserver = () => {};
  vi.spyOn(operation, "abort").mockImplementation(() => {
    if (!vi.isFakeTimers()) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const schedule = globalThis.setTimeout;
      const observer = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, ms, ...args) => {
          const timer = schedule(callback, ms, ...args);
          if (ms === 15_000) {
            deadlineArmed.resolve();
          }
          return timer;
        });
      restoreDeadlineObserver = () => {
        restoreDeadlineObserver = () => {};
        observer.mockRestore();
      };
    }
    preemptAttempted.resolve();
    return false;
  });
  const deletion = deleteSession({ key: "discord:group:dev" });
  void deletion.catch(() => {});
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        preemptAttempted.promise,
        deletion,
        "Session deletion settled before attempting to stop its active run",
      ),
      signal,
    );
    // The short mutation releases before draining; its admission closure stays held.
    expect(readSessionControllerAdmissionError({ target })).toMatchObject({
      code: "OPENCLAW_DIRECT_ABORT",
    });
    await withinTest(deadlineArmed.promise, signal);
    await vi.advanceTimersByTimeAsync(15_000);
    restoreDeadlineObserver();
    vi.useRealTimers();

    const deleted = await withinTest(deletion, signal);
    expect(deleted.ok).toBe(false);
    expect(deleted.error).toEqual({
      code: "UNAVAILABLE",
      message:
        "Session discord:group:dev could not safely stop before deletion: Session work is still active after the lifecycle drain for agent:main:discord:group:dev. Wait for active work to end, then retry; session storage has been preserved. Retry after active work or worker recovery finishes.",
      retryable: true,
    });
    expect(retireRuntime).not.toHaveBeenCalled();
    expect(closeTabs).not.toHaveBeenCalled();

    expect(loadSessionEntry({ sessionKey: target.sessionKey, storePath })?.sessionId).toBe(
      "sess-active",
    );
    const filesAfterDeleteAttempt = await fs.readdir(dir);
    expect(
      filesAfterDeleteAttempt.filter((fileName) =>
        fileName.startsWith("sess-active.jsonl.deleted."),
      ),
    ).toEqual([]);
  } finally {
    restoreDeadlineObserver();
    vi.useRealTimers();
    operation.complete();
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
    await deletion.catch(() => undefined);
  }
});

test("sessions.delete refreshes memory metadata changed by cleanup without an ambient actor", async () => {
  const session = await seedIncognito("delete", {
    modelSelectionLocked: true,
    pluginOwnerId: "synthetic-plugin",
  });
  try {
    closeTabs.mockImplementationOnce(async () => {
      await session.write(undefined, { updatedAt: 2, label: "Cleanup metadata" });
      return 0;
    });
    const result = await deleteSession({ key: session.key });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(closeTabs).toHaveBeenCalledOnce();
    expect(session.read()).toBeUndefined();
  } finally {
    memorySessionActorOwners.closeDatabase({ agentId: "main", path: session.storePath });
  }
});

test("reset deletion settles when its caller releases a memory actor during the before-delete hook", async () => {
  const session = await seedIncognito("reset");
  const borrowed = await acquireSessionActorStorage(session.target, {
    lifetime: { assertCurrent() {}, assertReadable() {} },
    authority: { assertCurrent() {}, authorize() {} },
  });
  assert(borrowed, "Expected the existing memory actor");
  try {
    expect(
      await deleteIncognitoSessionForReset({
        key: session.key,
        agentId: "main",
        storePath: session.storePath,
        target: { canonicalKey: session.key, storeKeys: [session.key] },
        entry: session.entry,
        commitGuard() {},
        beforeDelete: () => borrowed.actor.release(),
      }),
    ).toMatchObject({ ok: true, value: { deletedSessionId: session.id } });
    expect(session.read()).toBeUndefined();
  } finally {
    await borrowed.actor.release();
    memorySessionActorOwners.closeDatabase({ agentId: "main", path: session.storePath });
  }
});
