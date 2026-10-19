// Compare-and-swap session patches must reject reset replacements atomically.
import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { SessionEntry } from "../config/sessions/types.js";
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

async function seedSession(
  sessionKey: string,
  entry: Partial<SessionEntry> = {},
  sessionId = sessionKey.slice(sessionKey.lastIndexOf(":") + 1),
) {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId, entry) } });
  return {
    sessionKey,
    storePath,
    read: () => loadSessionEntry({ sessionKey, storePath }),
    patch: (params: Record<string, unknown>) =>
      directSessionReq("sessions.patch", { key: sessionKey, ...params }),
  };
}

const changed = (sessionKey: string) => ({
  ok: false,
  error: {
    message: `Session ${sessionKey} changed before patch. Retry.`,
    details: { reason: "session-changed" },
  },
});
const invalid = (message: string) => ({ ok: false, error: { code: "INVALID_REQUEST", message } });

function observingContext() {
  return {
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
  };
}

function expectNoPublication(context: ReturnType<typeof observingContext>) {
  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  expect(context.broadcastToConnIds).not.toHaveBeenCalled();
}

afterEach(async () => {
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

test.each([undefined, "session-a"])(
  "sessions.patch rejects missing archive targets (expected identity: %s)",
  async (expectedSessionId) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:missing-lifecycle-target";
    const context = observingContext();
    await writeSessionStore({ entries: {} });
    const result = await directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId },
      { context },
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
    expectNoPublication(context);
  },
);

test.each([
  { name: "session id", expected: { expectedSessionId: "sess-before-reset" } },
  { name: "lifecycle revision", expected: { expectedLifecycleRevision: "revision-before-reset" } },
])("sessions.patch rejects a replaced $name before archive side effects", async ({ expected }) => {
  const sessionKey = "agent:main:subagent:active-replacement";
  const replacementSessionId = "sess-active-after-reset";
  const { read } = await seedSession(
    sessionKey,
    { lifecycleRevision: "revision-after-reset" },
    replacementSessionId,
  );
  const replacementBefore = read();
  const context = observingContext();
  embeddedRunMock.activeIds.add(replacementSessionId);

  const result = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, ...expected },
    { context },
  );

  expect(result).toMatchObject(changed(sessionKey));
  expect(read()).toEqual(replacementBefore);
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expectNoPublication(context);
});

test("sessions.patch rejects a session replaced before restore reaches the SQLite writer", async () => {
  const patchPreparation = await import("./server-methods/sessions-patch-expectations.js");
  const sessionKey = "agent:main:restore-generation-race";
  const originalSessionId = "restored-original";
  const { storePath, read } = await seedSession(sessionKey, { archivedAt: 1 }, originalSessionId);

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
  const context = observingContext();
  const restored = directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: false, expectedSessionId: originalSessionId },
    { context },
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
    expect(read()).toMatchObject({
      archivedAt: 2,
      sessionId: "restored-replacement",
    });
    expectNoPublication(context);
  } finally {
    replaceSession.resolve();
    await Promise.allSettled([writer, restored]);
    preflight.mockRestore();
  }
});

test("sessions.patch rejects stale lifecycle revisions for metadata mutations", async () => {
  const sessionKey = "agent:main:subagent:metadata-identity";
  const { read, patch } = await seedSession(
    sessionKey,
    { lifecycleRevision: "revision-after-reset" },
    "sess-after-reset",
  );
  const before = read();
  expect(
    await patch({
      label: "Stale agent request",
      expectedLifecycleRevision: "revision-before-reset",
    }),
  ).toMatchObject({
    ok: false,
    error: { message: `Session ${sessionKey} changed before patch. Retry.` },
  });
  expect(read()).toEqual(before);
});

test("sessions.patch preserves concurrent tool restrictions from a stale replacement", async () => {
  const original = { webSearch: false };
  const restricted = { ...original, mcpToolsDeny: { docs: ["delete"] } };
  const replacement = { ...original, skills: { release: false } };
  const { sessionKey, read, patch } = await seedSession("agent:main:tool-overrides-cas", {
    toolOverrides: original,
  });
  const concurrent = await patch({ toolOverrides: restricted });
  expect(concurrent.ok).toBe(true);

  const stale = await patch({ expectedToolOverrides: original, toolOverrides: replacement });

  const expected = changed(sessionKey);
  expect(stale).toMatchObject({
    ...expected,
    error: { ...expected.error, code: "INVALID_REQUEST" },
  });
  expect(read()?.toolOverrides).toEqual(restricted);
  const fresh = await patch({ expectedToolOverrides: restricted, toolOverrides: replacement });
  expect(fresh.ok).toBe(true);
  expect(read()?.toolOverrides).toEqual(replacement);
});

test("sessions.patch requires expected tool overrides to guard a replacement", async () => {
  const { read, patch } = await seedSession("agent:main:tool-overrides-cas-envelope", {
    toolOverrides: { webSearch: false },
  });
  const result = await patch({
    expectedToolOverrides: { webSearch: false },
    label: "unguarded replacement",
  });

  expect(result).toMatchObject(
    invalid("expectedToolOverrides requires a toolOverrides replacement."),
  );
  expect(read()).not.toHaveProperty("label");
});

test("sessions.patch rejects stale permission replacement", async () => {
  const { read, patch } = await seedSession("agent:main:permission-mode-cas", {
    permissionMode: "guarded",
  });
  await patch({ permissionMode: "read-only" });
  const stale = await patch({
    expectedPermissionMode: "guarded",
    permissionMode: "full",
  });

  expect(stale).toMatchObject({
    ok: false,
    error: { details: { reason: "session-changed" } },
  });
  expect(read()?.permissionMode).toBe("read-only");
});

test("sessions.patch rejects automatic acknowledgement with another mutation", async () => {
  const { read, patch } = await seedSession("agent:main:conditional-unread-label", {
    markedUnreadAt: 10,
  });
  const result = await patch({
    unread: false,
    expectedMarkedUnreadAt: 9,
    label: "Must not be discarded",
  });

  expect(result).toMatchObject(
    invalid("expectedMarkedUnreadAt requires unread=false as the only mutation."),
  );
  expect(read()).toMatchObject({
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
      startedAt: 100,
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
      startedAt: 100,
      lifecycleRunId: "interleaved-run",
    });
  } finally {
    authorizePatch.resolve();
    await Promise.allSettled([patched, lifecycleWrite]);
  }
});

test("sessions.patch keeps explicit unread markers strictly advancing", async () => {
  const { read, patch } = await seedSession("agent:main:conditional-unread-revision");
  const now = vi.spyOn(Date, "now").mockReturnValue(100);

  try {
    await patch({ unread: true });
    const firstMarker = read()?.markedUnreadAt;
    await patch({ unread: true });
    const secondMarker = read()?.markedUnreadAt;

    expect(firstMarker).toBe(100);
    expect(secondMarker).toBe(101);
    const staleRead = await patch({
      unread: false,
      expectedMarkedUnreadAt: firstMarker,
    });
    expect(staleRead).toMatchObject({ ok: true });
    expect(read()?.markedUnreadAt).toBe(secondMarker);
  } finally {
    now.mockRestore();
  }
});

test("sessions.patch preserves legacy read semantics for manual markers", async () => {
  const { read, patch } = await seedSession("agent:main:mixed-version-unread", {
    markedUnreadAt: 10,
  });
  const legacyRead = await patch({ unread: false });

  expect(legacyRead).toMatchObject({ ok: true });
  expect(read()?.markedUnreadAt).toBeUndefined();
  expect(read()?.lastReadAt).toEqual(expect.any(Number));
});
