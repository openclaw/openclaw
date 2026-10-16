import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type {
  SessionsDeleteParams,
  SessionsDeleteResult,
} from "../../packages/gateway-protocol/src/schema/sessions.js";
import { createDeferred } from "../../test/helpers/promise.js";
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
import { acquireSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { readAttachedSessionEndTranscriptSourceForTest } from "../plugins/session-end-transcript.test-support.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
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
  return deleted;
}

async function expectSessionDeleteChanged(request: SessionsDeleteParams) {
  const deleted = await deleteSession(request);
  expect(deleted).toMatchObject({
    ok: false,
    error: {
      message: `Session ${request.key} changed before deletion. Retry.`,
    },
  });
  expect(deleted.error?.details).toEqual({ reason: "session-changed" });
  return deleted;
}

async function seedSessions(
  ...sessions: Array<[key: string, id: string, options?: Partial<SessionEntry>]>
) {
  const store = await createSessionStoreDir();
  await writeSessionStore({
    entries: Object.fromEntries(
      sessions.map(([key, id, options]) => [key, sessionStoreEntry(id, options)]),
    ),
  });
  for (const [, id] of sessions) {
    await writeSingleLineSession(store.dir, id, id);
  }
  return store;
}

async function seedSession(
  sessionKey: string,
  sessionId: string,
  options?: Parameters<typeof sessionStoreEntry>[1],
) {
  const store = await createSessionStoreDir();
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId, options) } });
  return store;
}

async function createIncognitoFixture(
  sessionKey: string,
  sessionId: string,
  options: Partial<SessionEntry> = {},
) {
  await createSessionStoreDir();
  const location = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
  };
  const scope = { agentId: "main", storePath: location.path, sessionKey };
  const entry = {
    sessionId,
    lifecycleRevision: "initial",
    updatedAt: 1,
    incognito: true,
    ...options,
  };
  return { location, scope, entry };
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
  expect(result).toMatchObject({
    ok: false,
    error: { message: "Cannot delete the main session (global)." },
  });
  expect(loadSessionEntry(target)).toEqual(before);
  expect(embeddedRunMock.abortCalls).not.toContain("sole-global");
  expect(disposeRuntime).not.toHaveBeenCalled();
  expect(closeTabs).not.toHaveBeenCalled();
});

test("sessions.delete rejects main and aborts active runs", async () => {
  await seedSessions(["main", "sess-main"], ["discord:group:dev", "sess-active"]);

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", true);

  const mainDelete = await deleteSession({ key: "main" });
  expect(mainDelete.ok).toBe(false);

  await expectSessionDeleteSucceeds({ key: "discord:group:dev" });
  expect(embeddedRunMock.abortCalls).toContain("sess-active");
  expect(embeddedRunMock.activeIds.has("sess-active")).toBe(false);
  expect(disposeRuntime).toHaveBeenCalledWith("sess-active");
  expect(closeTabs).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sessionKeys: ["agent:main:discord:group:dev", "agent:main:sess-active"],
      onWarn: expect.any(Function),
    }),
  );
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledExactlyOnceWith(
    {
      targetSessionKey: "agent:main:discord:group:dev",
      targetKind: "acp",
      reason: "session-delete",
      sendFarewell: true,
      outcome: "deleted",
    },
    {
      childSessionKey: "agent:main:discord:group:dev",
    },
  );
  expect(unbind).toHaveBeenCalledExactlyOnceWith({
    targetSessionKey: "agent:main:discord:group:dev",
    reason: "session-delete",
  });
});

test("sessions.delete preserves locked archived sessions and deletes ordinary archived sessions", async () => {
  const lockedKey = "agent:main:harness:codex:supervision:native-thread";
  const ordinaryKey = "agent:main:ordinary-archived";
  const lockedSessionId = "sess-locked-archived";
  const ordinarySessionId = "sess-ordinary-archived";
  const { dir, storePath } = await seedSessions(
    [
      lockedKey,
      lockedSessionId,
      {
        agentHarnessId: "codex",
        archivedAt: Date.now(),
        modelSelectionLocked: true,
      },
    ],
    [ordinaryKey, ordinarySessionId, { archivedAt: Date.now() }],
  );
  const lockedEntryBefore = structuredClone(loadSessionEntry({ storePath, sessionKey: lockedKey }));
  const lockedTranscriptPath = path.join(dir, `${lockedSessionId}.jsonl`);
  const lockedTranscriptBefore = await fs.readFile(lockedTranscriptPath, "utf8");

  const rejected = await deleteSession({ key: lockedKey, archivedOnly: true });
  expect(rejected).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "This session cannot be deleted while model selection is locked.",
    },
  });
  expect(loadSessionEntry({ storePath, sessionKey: lockedKey })).toEqual(lockedEntryBefore);
  expect(await fs.readFile(lockedTranscriptPath, "utf8")).toBe(lockedTranscriptBefore);

  await expectSessionDeleteSucceeds({ key: ordinaryKey, archivedOnly: true });
  expect(loadSessionEntry({ storePath, sessionKey: ordinaryKey })).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: lockedKey })).toEqual(lockedEntryBefore);
});

test("sessions.delete removes a locked plugin-owned session from its persisted alias", async () => {
  const requestedKey = "agent:main:catalog-owned";
  const persistedKey = "catalog-owned";
  const canonicalSessionId = "sess-catalog-owned-canonical";
  const aliasSessionId = "sess-catalog-owned-alias";
  const owner = { modelSelectionLocked: true, pluginOwnerId: "anthropic" };
  const { storePath } = await seedSession(requestedKey, canonicalSessionId, {
    ...owner,
    updatedAt: 2,
  });
  await replaceSessionEntry(
    { agentId: "main", sessionKey: persistedKey, storePath },
    sessionStoreEntry(aliasSessionId, { ...owner, updatedAt: 1 }),
  );
  for (const sessionId of [canonicalSessionId, aliasSessionId]) {
    await replaceTranscriptEvents({ sessionKey: requestedKey, sessionId, storePath }, [
      { type: "session", id: sessionId, content: sessionId },
      {
        type: "message",
        id: `${sessionId}-message`,
        parentId: null,
        message: { role: "user", content: `content for ${sessionId}` },
      },
    ]);
  }

  const deleted = await deleteSession({ key: persistedKey });

  expect(deleted.ok).toBe(true);
  expect(loadSessionEntry({ storePath, sessionKey: requestedKey })).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: persistedKey })).toBeUndefined();
  expect(deleted.payload?.archived).toEqual(
    expect.arrayContaining([
      expect.stringContaining(`${canonicalSessionId}.jsonl.deleted.`),
      expect.stringContaining(`${aliasSessionId}.jsonl.deleted.`),
    ]),
  );
  for (const sessionId of [canonicalSessionId, aliasSessionId]) {
    await expect(
      loadTranscriptEvents({ sessionKey: requestedKey, sessionId, storePath }),
    ).resolves.toEqual([]);
  }
  const endCall = sessionLifecycleHookMocks.runSessionEnd.mock.calls.at(0);
  if (!endCall) {
    throw new Error("expected session_end hook call");
  }
  const [endEvent, endContext] = endCall;
  const endedTranscript = readAttachedSessionEndTranscriptSourceForTest(endContext);
  expect(endedTranscript.available).toBe(true);
  if (!endedTranscript.available || !endEvent?.sessionId) {
    throw new Error("expected archived ended transcript source");
  }
  await expect(
    endedTranscript.readTail({ maxMessages: 10, maxBytes: 64 * 1_024 }),
  ).resolves.toMatchObject({
    messages: [
      expect.objectContaining({ role: "user", content: `content for ${endEvent.sessionId}` }),
    ],
    totalMessages: 1,
    truncated: false,
  });
});

test.each(["session id", "updated at"] as const)(
  "sessions.delete rechecks expected %s before interrupting replacement work",
  async (guard) => {
    const sessionKey = "agent:main:subagent:worker";
    const originalSessionId = "sess-original";
    const replacementSessionId = guard === "session id" ? "sess-replacement" : originalSessionId;
    const { storePath } = await seedSession(sessionKey, originalSessionId, {
      updatedAt: 1,
      lifecycleRevision: "same-lifecycle",
    });
    let replacementInterrupted = false;
    const replacementAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, replacementSessionId],
      assertAllowed: () => {},
      onInterrupt: () => {
        replacementInterrupted = true;
      },
    });
    const releaseBlockingMutation = createDeferred();
    const { promise: blockingMutationStarted, resolve: markBlockingMutationStarted } =
      createDeferred();
    const blockingMutation = runExclusiveSessionLifecycleMutation("delete", {
      scope: storePath,
      identities: [sessionKey],
      run: async () => {
        markBlockingMutationStarted();
        await releaseBlockingMutation.promise;
      },
    });
    await blockingMutationStarted;

    const deletion = deleteSession({
      key: sessionKey,
      expectedSessionId: originalSessionId,
      ...(guard === "updated at" ? { expectedSessionUpdatedAt: 1 } : {}),
    });
    await Promise.resolve();
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(replacementSessionId, {
          updatedAt: 2,
          lifecycleRevision: "same-lifecycle",
        }),
      },
    });
    releaseBlockingMutation.resolve();

    try {
      const [deleted] = await Promise.all([deletion, blockingMutation]);
      expect(deleted.ok).toBe(false);
      expect(replacementInterrupted).toBe(false);
    } finally {
      replacementAdmission.release();
    }
  },
);

test("sessions.delete rejects a same-key successor created during cleanup without a caller identity guard", async () => {
  const sessionKey = "agent:main:cleanup-successor";
  const { storePath } = await seedSession(sessionKey, "original-session");
  disposeRuntime.mockImplementationOnce(async () => {
    replaceSessionEntrySync({ sessionKey, storePath }, sessionStoreEntry("successor-session"));
  });
  await expectSessionDeleteChanged({ key: sessionKey });
  expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("successor-session");
});

test("sessions.delete serializes a patch behind asynchronous runtime cleanup", async () => {
  const patchPreparation = await import("./server-methods/sessions-patch-expectations.js");
  const sessionKey = "agent:main:subagent:worker";
  const sessionId = "sess-subagent";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await seedSession(sessionKey, sessionId, { updatedAt });
  const releaseRuntimeCleanup = createDeferred();
  const runtimeCleanupStarted = createDeferred();
  disposeRuntime.mockImplementationOnce(async () => {
    runtimeCleanupStarted.resolve();
    await releaseRuntimeCleanup.promise;
  });

  const deletion = deleteSession({
    key: sessionKey,
    expectedSessionId: sessionId,
    expectedSessionUpdatedAt: updatedAt,
  });
  await runtimeCleanupStarted.promise;
  let patchSettled = false;
  const { promise: patchPreflight, resolve: markPatchPreflight } = createDeferred();
  const prepareTargets = patchPreparation.prepareSessionPatchTargets;
  // Placement reads also run during fixture initialization, before patch captures its target.
  const preflight = vi
    .spyOn(patchPreparation, "prepareSessionPatchTargets")
    .mockImplementation((input) => {
      const prepared = prepareTargets(input);
      markPatchPreflight();
      return prepared;
    });
  const patch = directSessionReq("sessions.patch", {
    key: sessionKey,
    label: "updated during cleanup",
  }).then((result) => {
    patchSettled = true;
    return result;
  });
  try {
    await patchPreflight;
    expect(patchSettled).toBe(false);
    releaseRuntimeCleanup.resolve();

    const [deleted, patched] = await Promise.all([deletion, patch]);
    expect(deleted.ok).toBe(true);
    expect(patched).toMatchObject({
      ok: false,
      error: { message: `Session ${sessionKey} changed before patch. Retry.` },
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  } finally {
    releaseRuntimeCleanup.resolve();
    await Promise.allSettled([deletion, patch]);
    preflight.mockRestore();
  }
});

test("sessions.delete keeps lifecycle admission blocked through session unbinding", async () => {
  const sessionKey = "agent:main:subagent:worker";
  const sessionId = "sess-subagent";
  const { storePath } = await seedSession(sessionKey, sessionId);
  const releaseUnbind = createDeferred();
  const unbindStarted = createDeferred();
  unbind.mockImplementationOnce(async () => {
    unbindStarted.resolve();
    await releaseUnbind.promise;
    return [];
  });

  let workerDraining = false;
  const workerEnvironmentService = createWorkerInferenceDrainService(() => {
    workerDraining = true;
    return {
      drained: Promise.resolve(),
      hasWork: () => false,
      release: () => {
        workerDraining = false;
      },
    };
  });
  const deletion = deleteSession({ key: sessionKey }, { context: { workerEnvironmentService } });
  await unbindStarted.promise;
  let replacementAdmitted = false;
  const replacement = beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, sessionId],
    assertAllowed: () => {
      if (workerDraining) {
        throw new Error("worker drain still owns the session");
      }
    },
  }).then((lease) => {
    replacementAdmitted = true;
    return lease;
  });
  await Promise.resolve();
  expect(replacementAdmitted).toBe(false);

  releaseUnbind.resolve();
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
  let foreignWorkInterrupted = false;
  const foreignAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [foreignKey, "sess-foreign"],
    assertAllowed: () => {},
    onInterrupt: () => {
      foreignWorkInterrupted = true;
    },
  });

  try {
    const denied = await deleteSession({ key: foreignKey }, { client: pluginClient });
    expect(denied).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("did not create it") },
    });
    expect(foreignWorkInterrupted).toBe(false);
  } finally {
    foreignAdmission.release();
  }

  const deleted = await deleteSession({ key: ownedKey }, { client: pluginClient });
  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
});

test.each(["sessions.delete", "sessions.reset"] as const)(
  "%s scopes selected global cleanup to the requested agent",
  async (method) => {
    const globalStores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });
    const mainTarget = {
      agentId: "main",
      sessionKey: "global",
      storePath: globalStores.mainStorePath,
    };
    const workTarget = { ...mainTarget, agentId: "work", storePath: globalStores.workStorePath };
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
      await resetConfiguredGlobalAgentSessionStore(globalStores);
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

test("sessions.delete returns unavailable when active run does not stop", async () => {
  const { dir, storePath } = await seedSessions(["discord:group:dev", "sess-active"]);

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", false);
  const { ws } = await openClient();

  const deleted = await rpcReq(ws, "sessions.delete", {
    key: "discord:group:dev",
  });
  expect(deleted).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", message: expect.stringMatching(/still active/i) },
  });
  expect(embeddedRunMock.abortCalls).toContain("sess-active");
  expect(embeddedRunMock.waitCalls).toContain("sess-active");
  expect(retireRuntime).not.toHaveBeenCalled();
  expect(closeTabs).not.toHaveBeenCalled();

  const storedEntry = loadSessionEntry({
    sessionKey: "agent:main:discord:group:dev",
    storePath,
  });
  expect(storedEntry?.sessionId).toBe("sess-active");
  const filesAfterDeleteAttempt = await fs.readdir(dir);
  expect(
    filesAfterDeleteAttempt.filter((fileName) => fileName.startsWith("sess-active.jsonl.deleted.")),
  ).toEqual([]);

  ws.close();
});

test("sessions.delete refreshes memory metadata changed by cleanup without an ambient actor", async () => {
  const sessionKey = "agent:main:dashboard:incognito-delete-composition";
  const { location, scope, entry } = await createIncognitoFixture(
    sessionKey,
    "delete-composition",
    {
      modelSelectionLocked: true,
      pluginOwnerId: "synthetic-plugin",
    },
  );
  try {
    await replaceSessionEntry(scope, entry);
    closeTabs.mockImplementationOnce(async () => {
      await replaceSessionEntry(scope, { ...entry, updatedAt: 2, label: "Cleanup metadata" });
      return 0;
    });
    const result = await deleteSession({ key: sessionKey });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(closeTabs).toHaveBeenCalledOnce();
    expect(loadSessionEntry(scope)).toBeUndefined();
  } finally {
    memorySessionActorOwners.closeDatabase(location);
  }
});

test("reset deletion settles when its caller releases a memory actor during the before-delete hook", async () => {
  const sessionKey = "agent:main:dashboard:incognito-reset-composition";
  const { location, scope, entry } = await createIncognitoFixture(sessionKey, "reset-composition");
  await replaceSessionEntry(scope, entry);
  const borrowed = await acquireSessionActorStorage(scope, {
    lifetime: { assertCurrent() {}, assertReadable() {} },
    authority: { assertCurrent() {}, authorize() {} },
  });
  if (!borrowed) {
    throw new Error("Expected the existing memory actor");
  }
  try {
    expect(
      await deleteIncognitoSessionForReset({
        key: sessionKey,
        agentId: "main",
        storePath: location.path,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        entry,
        commitGuard() {},
        beforeDelete: () => borrowed.actor.release(),
      }),
    ).toMatchObject({ ok: true, value: { deletedSessionId: entry.sessionId } });
    expect(loadSessionEntry(scope)).toBeUndefined();
  } finally {
    await borrowed.actor.release();
    memorySessionActorOwners.closeDatabase(location);
  }
});
