// Session delete lifecycle tests protect transcript deletion, ACP metadata,
// active-run cleanup, hooks, thread bindings, and browser/MCP cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readAttachedSessionEndTranscriptSourceForTest } from "../plugins/session-end-transcript.test-support.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import type { CallGatewayOptions } from "./call.js";
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

type SessionDeleteRequest = {
  key: string;
  agentId?: string;
  archivedOnly?: boolean;
  deleteTranscript?: boolean;
  emitLifecycleHooks?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  expectedSessionUpdatedAt?: number;
};

async function expectSessionDeleteSucceeds(request: SessionDeleteRequest) {
  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    request,
  );
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  return deleted;
}

async function expectSessionDeleteChanged(request: SessionDeleteRequest) {
  const deleted = await directSessionReq("sessions.delete", request);
  expect(deleted.ok).toBe(false);
  expect(deleted.error?.message).toBe(`Session ${request.key} changed before deletion. Retry.`);
  expect((deleted.error as { details?: unknown } | undefined)?.details).toEqual({
    reason: "session-changed",
  });
  return deleted;
}

async function seedSubagentWorkerSession() {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-subagent", "hello");
  await writeSessionStore({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });
}

function expectThreadBindingsUnbound(targetSessionKey: string) {
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey,
    reason: "session-delete",
  });
}

test("sessions.delete protects the sole explicit agent's global session before cleanup", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { ownership: "explicit", entries: { ops: {} } };
  testState.sessionConfig = { scope: "global" };
  const target = { agentId: "ops", sessionKey: "global", storePath };
  await replaceSessionEntry(target, sessionStoreEntry("sole-global"));
  const before = loadSessionEntry(target);
  embeddedRunMock.activeIds.add("sole-global");
  embeddedRunMock.waitResults.set("sole-global", true);

  const result = await directSessionReq("sessions.delete", { key: "global", agentId: "ops" });

  expect(result.ok).toBe(false);
  expect(result.error?.message).toBe("Cannot delete the main session (global).");
  expect(loadSessionEntry(target)).toEqual(before);
  expect(embeddedRunMock.abortCalls).not.toContain("sole-global");
  expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).not.toHaveBeenCalled();
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
});

test("sessions.delete rejects main and aborts active runs", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-active", "active");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:dev": sessionStoreEntry("sess-active"),
    },
  });

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", true);

  const mainDelete = await directSessionReq("sessions.delete", { key: "main" });
  expect(mainDelete.ok).toBe(false);

  await expectSessionDeleteSucceeds({
    key: "discord:group:dev",
  });
  expect(embeddedRunMock.abortCalls).toContain("sess-active");
  expect(embeddedRunMock.activeIds.has("sess-active")).toBe(false);
  expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledWith("sess-active");
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
  const closeTabsCall = (
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mock.calls as unknown as Array<
      [{ sessionKeys?: string[]; onWarn?: unknown }]
    >
  )[0]?.[0];
  expect(closeTabsCall?.sessionKeys).toHaveLength(3);
  expect(closeTabsCall?.sessionKeys).toContain("discord:group:dev");
  expect(closeTabsCall?.sessionKeys).toContain("agent:main:discord:group:dev");
  expect(closeTabsCall?.sessionKeys).toContain("sess-active");
  expect(typeof closeTabsCall?.onWarn).toBe("function");
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
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
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:discord:group:dev",
    reason: "session-delete",
  });
});

test("sessions.delete preserves locked archived sessions and deletes ordinary archived sessions", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const lockedKey = "agent:main:harness:codex:supervision:native-thread";
  const ordinaryKey = "agent:main:ordinary-archived";
  const lockedSessionId = "sess-locked-archived";
  const ordinarySessionId = "sess-ordinary-archived";
  await writeSingleLineSession(dir, lockedSessionId, "locked");
  await writeSingleLineSession(dir, ordinarySessionId, "ordinary");
  await writeSessionStore({
    entries: {
      [lockedKey]: sessionStoreEntry(lockedSessionId, {
        agentHarnessId: "codex",
        archivedAt: Date.now(),
        modelSelectionLocked: true,
      }),
      [ordinaryKey]: sessionStoreEntry(ordinarySessionId, { archivedAt: Date.now() }),
    },
  });
  const lockedEntryBefore = structuredClone(loadSessionEntry({ storePath, sessionKey: lockedKey }));
  const lockedTranscriptPath = path.join(dir, `${lockedSessionId}.jsonl`);
  const lockedTranscriptBefore = await fs.readFile(lockedTranscriptPath, "utf8");

  const rejected = await directSessionReq("sessions.delete", {
    key: lockedKey,
    archivedOnly: true,
  });
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "This session cannot be deleted while model selection is locked.",
  });
  expect(loadSessionEntry({ storePath, sessionKey: lockedKey })).toEqual(lockedEntryBefore);
  expect(await fs.readFile(lockedTranscriptPath, "utf8")).toBe(lockedTranscriptBefore);

  await expectSessionDeleteSucceeds({ key: ordinaryKey, archivedOnly: true });
  expect(loadSessionEntry({ storePath, sessionKey: ordinaryKey })).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: lockedKey })).toEqual(lockedEntryBefore);
});

test("sessions.delete removes a locked plugin-owned session from its persisted alias", async () => {
  const { storePath } = await createSessionStoreDir();
  const requestedKey = "agent:main:catalog-owned";
  const persistedKey = "catalog-owned";
  const canonicalSessionId = "sess-catalog-owned-canonical";
  const aliasSessionId = "sess-catalog-owned-alias";
  await writeSessionStore({
    entries: {
      [requestedKey]: sessionStoreEntry(canonicalSessionId, {
        modelSelectionLocked: true,
        pluginOwnerId: "anthropic",
        updatedAt: 2,
      }),
    },
  });
  await replaceSessionEntry(
    { agentId: "main", sessionKey: persistedKey, storePath },
    sessionStoreEntry(aliasSessionId, {
      modelSelectionLocked: true,
      pluginOwnerId: "anthropic",
      updatedAt: 1,
    }),
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

  const deleted = await directSessionReq<{ archived: string[]; deleted: boolean; ok: true }>(
    "sessions.delete",
    {
      key: persistedKey,
    },
  );

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
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:subagent:worker";
    const originalSessionId = "sess-original";
    const replacementSessionId = guard === "session id" ? "sess-replacement" : originalSessionId;
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(originalSessionId, {
          updatedAt: 1,
          lifecycleRevision: "same-lifecycle",
        }),
      },
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
    let releaseBlockingMutation = () => {};
    const { promise: blockingMutationStarted, resolve: markBlockingMutationStarted } =
      createDeferred();
    const blockingMutation = runExclusiveSessionLifecycleMutation("delete", {
      scope: storePath,
      identities: [sessionKey],
      run: async () => {
        markBlockingMutationStarted();
        await new Promise<void>((release) => {
          releaseBlockingMutation = release;
        });
      },
    });
    await blockingMutationStarted;

    const deletion = directSessionReq("sessions.delete", {
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
    releaseBlockingMutation();

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
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry("original-session") } });
  bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockImplementationOnce(async () => {
    replaceSessionEntrySync({ sessionKey, storePath }, sessionStoreEntry("successor-session"));
  });
  await expectSessionDeleteChanged({ key: sessionKey });
  expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("successor-session");
});

test("sessions.delete includes cleanup-owned row changes in its guarded deletion", async () => {
  const sessionKey = "agent:main:cron:cleanup";
  const sessionId = "sess-cleanup";
  const lifecycleRevision = "cleanup-revision";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision, updatedAt }),
    },
  });
  bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockImplementationOnce(async () => {
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, {
          label: "cleanup-owned revision",
          lifecycleRevision,
          updatedAt: updatedAt + 1,
        }),
      },
    });
  });

  const deleted = await expectSessionDeleteSucceeds({
    key: sessionKey,
    expectedSessionId: sessionId,
    expectedLifecycleRevision: lifecycleRevision,
    expectedSessionUpdatedAt: updatedAt,
  });

  expect(deleted.payload?.deleted).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
});

test("sessions.delete serializes a patch behind asynchronous runtime cleanup", async () => {
  const patchPreparation = await import("./server-methods/sessions-patch-expectations.js");
  const sessionKey = "agent:main:subagent:worker";
  const sessionId = "sess-subagent";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { updatedAt }),
    },
  });
  let releaseRuntimeCleanup = () => {};
  const runtimeCleanupStarted = new Promise<void>((resolve) => {
    bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockImplementationOnce(async () => {
      resolve();
      await new Promise<void>((release) => {
        releaseRuntimeCleanup = release;
      });
    });
  });

  const deletion = directSessionReq("sessions.delete", {
    key: sessionKey,
    expectedSessionId: sessionId,
    expectedSessionUpdatedAt: updatedAt,
  });
  await runtimeCleanupStarted;
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
    releaseRuntimeCleanup();

    const [deleted, patched] = await Promise.all([deletion, patch]);
    expect(deleted.ok).toBe(true);
    expect(patched.ok).toBe(false);
    expect(patched.error?.message).toBe(`Session ${sessionKey} changed before patch. Retry.`);
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  } finally {
    releaseRuntimeCleanup();
    await Promise.allSettled([deletion, patch]);
    preflight.mockRestore();
  }
});

test("sessions.delete keeps lifecycle admission blocked through session unbinding", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:worker";
  const sessionId = "sess-subagent";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
    },
  });
  let releaseUnbind = () => {};
  const unbindStarted = new Promise<void>((resolve) => {
    threadBindingMocks.unbindThreadBindingsBySessionKey.mockImplementationOnce(async () => {
      resolve();
      await new Promise<void>((release) => {
        releaseUnbind = release;
      });
      return [];
    });
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
  const deletion = directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    { key: sessionKey },
    { context: { workerEnvironmentService } },
  );
  await unbindStarted;
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

  releaseUnbind();
  const [deleted, replacementAdmission] = await Promise.all([deletion, replacement]);
  try {
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(replacementAdmitted).toBe(true);
  } finally {
    replacementAdmission.release();
  }
});

test("sessions.delete limits plugin-runtime cleanup to sessions owned by that plugin", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-owned", "owned");
  await writeSingleLineSession(dir, "sess-foreign", "foreign");

  await writeSessionStore({
    entries: {
      "agent:main:dreaming-narrative-owned": sessionStoreEntry("sess-owned", {
        pluginOwnerId: "memory-core",
      }),
      "agent:main:dreaming-narrative-foreign": sessionStoreEntry("sess-foreign", {
        pluginOwnerId: "other-plugin",
      }),
    },
  });

  const pluginClient = {
    connect: {
      scopes: ["operator.admin"],
    },
    internal: {
      pluginRuntimeOwnerId: "memory-core",
    },
  } as never;
  let foreignWorkInterrupted = false;
  const foreignAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:dreaming-narrative-foreign", "sess-foreign"],
    assertAllowed: () => {},
    onInterrupt: () => {
      foreignWorkInterrupted = true;
    },
  });

  try {
    const denied = await directSessionReq(
      "sessions.delete",
      {
        key: "agent:main:dreaming-narrative-foreign",
      },
      {
        client: pluginClient,
      },
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toContain("did not create it");
    expect(foreignWorkInterrupted).toBe(false);
  } finally {
    foreignAdmission.release();
  }

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    {
      key: "agent:main:dreaming-narrative-owned",
    },
    {
      client: pluginClient,
    },
  );
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
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
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-parent", "parent");
  await writeSingleLineSession(dir, "sess-child", "child");

  const acpMeta = (recordId: string) => ({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: `runtime:${recordId}`,
    mode: "oneshot" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  });

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "acp-parent": sessionStoreEntry("sess-parent"),
      "acp-child": sessionStoreEntry("sess-child", {
        spawnedBy: "agent:main:acp-parent",
      }),
    },
  });
  seedCanonicalAcpSessionMeta({
    sessionKey: "agent:main:acp-parent",
    meta: acpMeta("agent:main:acp-parent"),
  });
  seedCanonicalAcpSessionMeta({
    sessionKey: "agent:main:acp-child",
    meta: acpMeta("agent:main:acp-child"),
  });

  await expectSessionDeleteSucceeds({
    key: "acp-parent",
  });

  // Deleting the parent must also close its spawned ACP child, not just its own
  // runtime, otherwise the child's claude-agent-acp process is orphaned (#68916).
  const closedKeys = (
    acpManagerMocks.closeSession.mock.calls as unknown as Array<[{ sessionKey?: string }]>
  ).map((call) => call[0]?.sessionKey);
  expect(closedKeys).toContain("agent:main:acp-parent");
  expect(closedKeys).toContain("agent:main:acp-child");
  expect(readAcpSessionMeta({ sessionKey: "agent:main:acp-parent" })).toBeUndefined();
  expect(readAcpSessionMeta({ sessionKey: "agent:main:acp-child" })).toBeUndefined();
});

test("sessions.delete does not emit lifecycle events when nothing was deleted", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:missing",
  });

  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(false);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
});

test("sessions.delete can skip lifecycle hooks while still unbinding thread bindings", async () => {
  await seedSubagentWorkerSession();

  await expectSessionDeleteSucceeds({
    key: "agent:main:subagent:worker",
    emitLifecycleHooks: false,
  });
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete returns unavailable when active run does not stop", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-active", "active");

  await writeSessionStore({
    entries: {
      "discord:group:dev": sessionStoreEntry("sess-active"),
    },
  });

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", false);
  const { ws } = await openClient();

  const deleted = await rpcReq(ws, "sessions.delete", {
    key: "discord:group:dev",
  });
  expect(deleted.ok).toBe(false);
  expect(deleted.error?.code).toBe("UNAVAILABLE");
  expect(deleted.error?.message ?? "").toMatch(/still active/i);
  expect(embeddedRunMock.abortCalls).toContain("sess-active");
  expect(embeddedRunMock.waitCalls).toContain("sess-active");
  expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).not.toHaveBeenCalled();
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

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

test("delete-mode cleanup retains its native receipt while real Gateway deletion removes the original child", async () => {
  const { createLifecycleControllerFixture } =
    await import("../agents/subagents/registry/subagent-registry-lifecycle-controller.test-support.js");
  const { getCurrentSubagentRunOwner, subagentRuns } =
    await import("../agents/subagents/registry/subagent-registry-memory.js");
  const { mutateSubagentRuns, restoreSubagentRunsFromDisk } =
    await import("../agents/subagents/registry/subagent-registry-persistence.js");
  const { observeRootWork } =
    await import("../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js");
  const { loadSubagentRegistryFromSqlite } =
    await import("../agents/subagents/registry/subagent-registry.store.sqlite.js");
  const { addSubagentRunForTests } =
    await import("../agents/subagents/registry/subagent-registry.test-helpers.js");
  const { shouldKeepSubagentRunChildLink } =
    await import("../agents/subagents/registry/subagent-run-liveness.js");
  const { storePath } = await createSessionStoreDir();
  const childSessionKey = "agent:main:subagent:retained-delete-owner";
  const target = {
    sessionId: "retained-delete-original",
    lifecycleRevision: "retained-delete-revision",
  };
  await writeSessionStore({
    entries: {
      [childSessionKey]: sessionStoreEntry(target.sessionId, {
        lifecycleRevision: target.lifecycleRevision,
      }),
    },
  });
  const runId = "real-gateway-retained-delete-owner";
  await addSubagentRunForTests({
    runId,
    childSessionKey,
    cleanup: "delete",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "retain completion receipt",
    createdAt: Date.now() - 10,
    endedAt: Date.now() - 1,
    archiveAtMs: Date.now() + 60_000,
    expectsCompletionMessage: false,
  });
  const entry = subagentRuns.get(runId);
  if (!entry) {
    throw new Error("Native worker did not publish the proof run");
  }
  const notifyContextEngineSubagentEnded = vi.fn(async () => {});
  const callGateway = async <T = Record<string, unknown>>(
    request: CallGatewayOptions,
  ): Promise<T> => {
    if (request.method !== "sessions.delete" || !isRecord(request.params)) {
      throw new Error("Proof expected a sessions.delete request with record parameters");
    }
    await request.prepareDispatchCurrent?.();
    request.assertDispatchCurrent?.();
    const result = await directSessionReq<T>("sessions.delete", request.params);
    if (!result.ok || result.payload === undefined) {
      throw new Error(result.error?.message ?? "Proof Gateway deletion failed");
    }
    return result.payload;
  };
  const controller = createLifecycleControllerFixture(
    { entry, runs: subagentRuns, realWorker: true, notifyContextEngineSubagentEnded },
    {
      callGateway,
      cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
      ownersByEntry: new Map(),
    },
  );
  const join = observeRootWork();
  try {
    expect(controller.startSubagentAnnounceCleanupFlow(runId, entry)).toBe(true);
    await join();
    const completed = getCurrentSubagentRunOwner(subagentRuns, entry);
    if (!completed) {
      throw new Error("Cleanup removed the retained native receipt");
    }
    expect(completed).toMatchObject({
      cleanupCompletedAt: expect.any(Number),
      deleteCleanupTarget: target,
      deleteCleanupDispatchedAt: expect.any(Number),
    });
    expect(loadSessionEntry({ sessionKey: childSessionKey, storePath })).toBeUndefined();
    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      cleanupCompletedAt: completed.cleanupCompletedAt,
      deleteCleanupTarget: target,
    });
    expect(shouldKeepSubagentRunChildLink(completed, { childSessionExists: false })).toBe(false);
    expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionKey, reason: "deleted" }),
      expect.any(Object),
    );
    console.log(
      "OPENCLAW_DELETE_RETENTION_PROOF " +
        JSON.stringify({
          runId,
          nativeReceiptRetained: true,
          originalSessionDeleted: true,
          contextEndReason: "deleted",
          noDeletedChildNavigation: true,
        }),
    );
  } finally {
    await join();
    controller.clearScheduledResumeTimers();
    await restoreSubagentRunsFromDisk({ runs: subagentRuns });
    if (subagentRuns.has(runId)) {
      await mutateSubagentRuns([runId], () => ({
        value: undefined,
        postimages: new Map([[runId, null]]),
      }));
    }
  }
});
