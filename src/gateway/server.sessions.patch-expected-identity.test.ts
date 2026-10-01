// Compare-and-swap session patches must reject reset replacements atomically.
import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { createDeferredCore as createDeferred } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  expectNoSessionQueueCleanup,
  sessionHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

test.each([undefined, "session-a"])(
  "sessions.patch rejects missing archive targets (expected identity: %s)",
  async (expectedSessionId) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:missing-lifecycle-target";
    const broadcastToConnIds = vi.fn();
    await writeSessionStore({ entries: {} });
    const result = await directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId },
      {
        context: {
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
        },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        ...(expectedSessionId
          ? { details: { reason: "session-changed" } }
          : { message: `session not found: ${sessionKey}` }),
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expectNoSessionQueueCleanup();
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  },
);

test.each([
  { name: "session id", expected: { expectedSessionId: "sess-before-reset" } },
  { name: "lifecycle revision", expected: { expectedLifecycleRevision: "revision-before-reset" } },
])("sessions.patch rejects a replaced $name before archive side effects", async ({ expected }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:active-replacement";
  const replacementSessionId = "sess-active-after-reset";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(replacementSessionId, {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });
  const replacementBefore = loadSessionEntry({ sessionKey, storePath });
  const broadcastToConnIds = vi.fn();
  embeddedRunMock.activeIds.add(replacementSessionId);

  const result = await directSessionReq(
    "sessions.patch",
    {
      key: sessionKey,
      archived: true,
      ...expected,
    },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
      },
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: {
      message: `Session ${sessionKey} changed before patch. Retry.`,
      details: { reason: "session-changed" },
    },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toEqual(replacementBefore);
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  expect(broadcastToConnIds).not.toHaveBeenCalled();
});

test("sessions.patch rejects a session replaced before restore reaches the SQLite writer", async () => {
  const patchPreparation = await import("./server-methods/sessions-patch-expectations.js");
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:restore-generation-race";
  const originalSessionId = "restored-original";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(originalSessionId, { archivedAt: 1 }),
    },
  });

  const writerStarted = createDeferred();
  const replaceSession = createDeferred();
  const writer = applySessionEntryCanonicalReplacements({
    agentId: "main",
    sessionKeys: [sessionKey],
    storePath,
    update: async () => {
      writerStarted.resolve();
      await replaceSession.promise;
      return {
        replacements: [
          {
            entry: sessionStoreEntry("restored-replacement", { archivedAt: 2 }),
            previousSessionKeys: [],
            sessionKey,
          },
        ],
        result: undefined,
      };
    },
  });
  await writerStarted.promise;

  const preflightCompleted = createDeferred();
  const prepareTargets = patchPreparation.prepareSessionPatchTargets;
  const preflight = vi
    .spyOn(patchPreparation, "prepareSessionPatchTargets")
    .mockImplementation((input) => {
      const prepared = prepareTargets(input);
      preflightCompleted.resolve();
      return prepared;
    });
  const broadcastToConnIds = vi.fn();
  const restored = directSessionReq(
    "sessions.patch",
    {
      key: sessionKey,
      archived: false,
      expectedSessionId: originalSessionId,
    },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
      },
    },
  );

  try {
    await preflightCompleted.promise;
    replaceSession.resolve();
    await writer;
    expect(await restored).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { reason: "session-changed" },
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      archivedAt: 2,
      sessionId: "restored-replacement",
    });
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  } finally {
    replaceSession.resolve();
    await Promise.allSettled([writer, restored]);
    preflight.mockRestore();
  }
});

test("sessions.patch rejects stale lifecycle revisions for metadata mutations", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:metadata-identity";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-after-reset", {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });
  const before = loadSessionEntry({ sessionKey, storePath });
  expect(
    await directSessionReq("sessions.patch", {
      key: sessionKey,
      label: "Stale agent request",
      expectedLifecycleRevision: "revision-before-reset",
    }),
  ).toMatchObject({
    ok: false,
    error: { message: `Session ${sessionKey} changed before patch. Retry.` },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toEqual(before);
});

test("sessions.patch preserves concurrent tool restrictions from a stale replacement", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:tool-overrides-cas";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("tool-overrides-cas", {
        toolOverrides: { webSearch: false },
      }),
    },
  });

  const concurrent = await directSessionReq("sessions.patch", {
    key: sessionKey,
    toolOverrides: {
      webSearch: false,
      mcpToolsDeny: { docs: ["delete"] },
    },
  });
  expect(concurrent.ok).toBe(true);

  const stale = await directSessionReq("sessions.patch", {
    key: sessionKey,
    expectedToolOverrides: { webSearch: false },
    toolOverrides: {
      webSearch: false,
      skills: { release: false },
    },
  });

  expect(stale).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: `Session ${sessionKey} changed before patch. Retry.`,
      details: { reason: "session-changed" },
    },
  });
  expect(loadSessionEntry({ sessionKey, storePath })?.toolOverrides).toEqual({
    webSearch: false,
    mcpToolsDeny: { docs: ["delete"] },
  });

  const fresh = await directSessionReq("sessions.patch", {
    key: sessionKey,
    expectedToolOverrides: {
      webSearch: false,
      mcpToolsDeny: { docs: ["delete"] },
    },
    toolOverrides: {
      webSearch: false,
      skills: { release: false },
    },
  });
  expect(fresh.ok).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })?.toolOverrides).toEqual({
    webSearch: false,
    skills: { release: false },
  });
});

test("sessions.patch requires expected tool overrides to guard a replacement", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:tool-overrides-cas-envelope";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("tool-overrides-cas-envelope", {
        toolOverrides: { webSearch: false },
      }),
    },
  });

  const result = await directSessionReq("sessions.patch", {
    key: sessionKey,
    expectedToolOverrides: { webSearch: false },
    label: "unguarded replacement",
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "expectedToolOverrides requires a toolOverrides replacement.",
    },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("label");
});

test("sessions.patch rejects stale permission replacement", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:permission-mode-cas";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("permission-mode-cas", { permissionMode: "guarded" }),
    },
  });

  await directSessionReq("sessions.patch", {
    key: sessionKey,
    permissionMode: "read-only",
  });
  const stale = await directSessionReq("sessions.patch", {
    key: sessionKey,
    expectedPermissionMode: "guarded",
    permissionMode: "full",
  });

  expect(stale).toMatchObject({
    ok: false,
    error: { details: { reason: "session-changed" } },
  });
  expect(loadSessionEntry({ sessionKey, storePath })?.permissionMode).toBe("read-only");
});

test("sessions.patch rejects automatic acknowledgement with another mutation", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:conditional-unread-label";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("conditional-unread-label", { markedUnreadAt: 10 }),
    },
  });

  const result = await directSessionReq("sessions.patch", {
    key: sessionKey,
    unread: false,
    expectedMarkedUnreadAt: 9,
    label: "Must not be discarded",
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "expectedMarkedUnreadAt requires unread=false as the only mutation.",
    },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    markedUnreadAt: 10,
    sessionId: "conditional-unread-label",
  });
});

test.each([
  {
    name: "automatic read acknowledgement",
    method: "sessions.patch",
    patch: { unread: false },
    identity: { expectedMarkedUnreadAt: null },
    expected: { lastReadAt: expect.any(Number) },
  },
  {
    name: "batch pin",
    method: "sessions.patchMany",
    patch: { pinned: true },
    identity: {},
    expected: { pinnedAt: expect.any(Number) },
  },
])("preserves $name and an interleaved lifecycle write", async (scenario) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:patch-lifecycle-race";
  const keys =
    scenario.method === "sessions.patchMany" ? [sessionKey, `${sessionKey}-sibling`] : [sessionKey];
  await writeSessionStore({
    entries: Object.fromEntries(keys.map((key) => [key, sessionStoreEntry(key)])),
  });

  const authorizePatch = createDeferred();
  // Register outside the handler so this independent writer cannot borrow its
  // reentrant admission context when authorization releases the gate.
  const lifecycleWrite = authorizePatch.promise.then(() =>
    patchSessionEntryCore({ sessionKey, storePath }, () => ({
      status: "running",
      lifecycleRunId: "interleaved-run",
    })),
  );
  const assertCurrent = () => authorizePatch.resolve();
  const targets = keys.map((key) => ({ key, ...scenario.identity }));
  const params =
    scenario.method === "sessions.patchMany"
      ? { targets, patch: scenario.patch }
      : { ...targets[0], ...scenario.patch };
  const patched = directSessionReq(scenario.method, params, {
    sessionMutationAuthorization: { assertCurrent, assertTargetCurrent: assertCurrent },
  });
  try {
    const result = await patched;
    await lifecycleWrite;
    expect(result).toMatchObject({ ok: true });
    if (scenario.method === "sessions.patchMany") {
      expect(result.payload).toMatchObject({ outcomes: keys.map((key) => ({ key, ok: true })) });
    }
    for (const key of keys) {
      expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject(scenario.expected);
    }
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "running",
      lifecycleRunId: "interleaved-run",
    });
  } finally {
    authorizePatch.resolve();
    await Promise.allSettled([patched, lifecycleWrite]);
  }
});

test("sessions.patch keeps explicit unread markers strictly advancing", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:conditional-unread-revision";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("conditional-unread-revision"),
    },
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(100);

  try {
    await directSessionReq("sessions.patch", { key: sessionKey, unread: true });
    const firstMarker = loadSessionEntry({ sessionKey, storePath })?.markedUnreadAt;
    await directSessionReq("sessions.patch", { key: sessionKey, unread: true });
    const secondMarker = loadSessionEntry({ sessionKey, storePath })?.markedUnreadAt;

    expect(firstMarker).toBe(100);
    expect(secondMarker).toBe(101);
    const staleRead = await directSessionReq("sessions.patch", {
      key: sessionKey,
      unread: false,
      expectedMarkedUnreadAt: firstMarker,
    });
    expect(staleRead).toMatchObject({ ok: true });
    expect(loadSessionEntry({ sessionKey, storePath })?.markedUnreadAt).toBe(secondMarker);
  } finally {
    now.mockRestore();
  }
});

test("sessions.patch preserves legacy read semantics for manual markers", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:mixed-version-unread";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("mixed-version-unread", { markedUnreadAt: 10 }),
    },
  });

  const legacyRead = await directSessionReq("sessions.patch", {
    key: sessionKey,
    unread: false,
  });

  expect(legacyRead).toMatchObject({ ok: true });
  expect(loadSessionEntry({ sessionKey, storePath })?.markedUnreadAt).toBeUndefined();
  expect(loadSessionEntry({ sessionKey, storePath })?.lastReadAt).toEqual(expect.any(Number));
});
