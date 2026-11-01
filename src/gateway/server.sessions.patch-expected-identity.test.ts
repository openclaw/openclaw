// Compare-and-swap session patches must reject reset replacements atomically.
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore as createDeferred } from "../shared/deferred.js";
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

const changed = {
  ok: false,
  error: { code: "INVALID_REQUEST", details: { reason: "session-changed" } },
};
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
    expect(result).toMatchObject(
      expectedSessionId ? changed : invalid(`session not found: ${sessionKey}`),
    );
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expectNoSessionQueueCleanup();
    expectNoPublication(context);
  },
);

test.each([
  [{ archived: true }, { expectedSessionId: "stale" }],
  [{ archived: true }, { expectedLifecycleRevision: "stale" }],
  [{ label: "Stale agent request" }, { expectedLifecycleRevision: "stale" }],
])(
  "sessions.patch rejects replaced targets (%j, %j) without side effects",
  async (patch, identity) => {
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
      { key: sessionKey, ...patch, ...identity },
      { context },
    );

    expect(result).toMatchObject(changed);
    expect(read()).toEqual(replacementBefore);
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expectNoPublication(context);
  },
);

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
    expect(await restored).toMatchObject(changed);
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

test("sessions.patch persists explicit web search preferences and preserves unset semantics", async () => {
  const { read, patch } = await seedSession("agent:main:web-search-preference");
  for (const toolOverrides of [
    { webSearch: true },
    { webSearch: false },
    { webSearch: true, skills: { docs: true } },
    { skills: { docs: true } },
    null,
  ]) {
    expect(await patch({ toolOverrides })).toMatchObject({ ok: true });
    expect(read()?.toolOverrides).toEqual(toolOverrides ?? undefined);
  }
});

test("sessions.patch preserves concurrent tool restrictions from a stale replacement", async () => {
  const original = { webSearch: false };
  const restricted = { ...original, mcpToolsDeny: { docs: ["delete"] } };
  const replacement = { ...original, skills: { release: false } };
  const { read, patch } = await seedSession("agent:main:tool-overrides-cas", {
    toolOverrides: original,
  });
  const concurrent = await patch({ toolOverrides: restricted });
  expect(concurrent.ok).toBe(true);

  const stale = await patch({ expectedToolOverrides: original, toolOverrides: replacement });

  expect(stale).toMatchObject(changed);
  expect(read()?.toolOverrides).toEqual(restricted);
  const fresh = await patch({ expectedToolOverrides: restricted, toolOverrides: replacement });
  expect(fresh.ok).toBe(true);
  expect(read()?.toolOverrides).toEqual(replacement);
});

test.each([
  {
    name: "expected tool overrides without a replacement",
    entry: { toolOverrides: { webSearch: false } },
    request: { expectedToolOverrides: { webSearch: false }, label: "unguarded replacement" },
    message: "expectedToolOverrides requires a toolOverrides replacement.",
  },
  {
    name: "automatic acknowledgement with another mutation",
    entry: { markedUnreadAt: 10 },
    request: { unread: false, expectedMarkedUnreadAt: 9, label: "Must not be discarded" },
    message: "expectedMarkedUnreadAt requires unread=false as the only mutation.",
  },
])("sessions.patch rejects $name", async ({ entry, request, message }) => {
  const { read, patch } = await seedSession("agent:main:invalid-patch-envelope", entry);
  const before = read();
  expect(await patch(request)).toMatchObject(invalid(message));
  expect(read()).toEqual(before);
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
  using _ = vi.spyOn(Date, "now").mockReturnValue(100);

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
});

test("sessions.patchMany preserves a manual unread marker set after the acknowledgement snapshot", async () => {
  const { storePath } = await createSessionStoreDir();
  const markedKey = "agent:main:subagent:marked-after-snapshot";
  const readKey = "agent:main:subagent:acknowledged";
  await writeSessionStore({
    entries: Object.fromEntries([markedKey, readKey].map((key) => [key, sessionStoreEntry(key)])),
  });
  const targets = [markedKey, readKey].map((key) => ({ key, expectedMarkedUnreadAt: null }));
  expect(await directSessionReq("sessions.patch", { key: markedKey, unread: true })).toMatchObject({
    ok: true,
  });
  const markedBefore = loadSessionEntry({ sessionKey: markedKey, storePath });

  const result = await directSessionReq("sessions.patchMany", {
    targets,
    patch: { unread: false },
  });

  expect(result).toMatchObject({
    ok: true,
    payload: { outcomes: targets.map(({ key }) => ({ key, ok: true })) },
  });
  expect(loadSessionEntry({ sessionKey: markedKey, storePath })).toEqual(markedBefore);
  expect(loadSessionEntry({ sessionKey: readKey, storePath })).toMatchObject({
    lastReadAt: expect.any(Number),
  });
});

test.each([
  { name: "unread=true", patch: { unread: true }, identity: {} },
  { name: "another mutation", patch: { unread: false, label: "Explicit change" }, identity: {} },
  {
    name: "incompatible expectations",
    patch: { unread: false },
    identity: { expectedCategory: null },
  },
])(
  "sessions.patchMany rejects a conditional acknowledgement with $name per target",
  async ({ patch, identity }) => {
    const { storePath } = await createSessionStoreDir();
    const guardedKey = "agent:main:guarded-unread-target";
    const plainKey = "agent:main:plain-unread-target";
    await writeSessionStore({
      entries: Object.fromEntries(
        [guardedKey, plainKey].map((key) => [key, sessionStoreEntry(key)]),
      ),
    });
    const guardedBefore = loadSessionEntry({ sessionKey: guardedKey, storePath });
    const result = await directSessionReq("sessions.patchMany", {
      targets: [{ key: guardedKey, expectedMarkedUnreadAt: null, ...identity }, { key: plainKey }],
      patch,
    });

    expect(result).toMatchObject({
      ok: true,
      payload: {
        outcomes: [
          {
            key: guardedKey,
            ...invalid("expectedMarkedUnreadAt requires unread=false as the only mutation."),
          },
          { key: plainKey, ok: true },
        ],
      },
    });
    expect(loadSessionEntry({ sessionKey: guardedKey, storePath })).toEqual(guardedBefore);
    expect(loadSessionEntry({ sessionKey: plainKey, storePath })).toMatchObject(
      patch.unread
        ? { markedUnreadAt: expect.any(Number) }
        : { lastReadAt: expect.any(Number), ...(patch.label ? { label: patch.label } : {}) },
    );
  },
);

describe("plugin session ownership", () => {
  const sessionKey = "agent:main:dreaming-narrative-owned";
  const sessionId = "plugin-session";
  let storePath: string;
  beforeEach(async () => {
    ({ storePath } = await createSessionStoreDir());
  });
  const readEntry = (key = sessionKey) => loadSessionEntry({ sessionKey: key, storePath });
  const ownedEntry = (pluginOwnerId = "memory-core") =>
    sessionStoreEntry(sessionId, { pluginOwnerId });
  const pluginOptions = (scope: "operator.write" | "operator.admin") => ({
    client: {
      connect: { scopes: [scope] },
      internal: { pluginRuntimeOwnerId: "memory-core" },
    } as never,
  });
  const writeOptions = pluginOptions("operator.write");
  const adminOptions = pluginOptions("operator.admin");
  const patch = (key: string, label: string, options = adminOptions) =>
    directSessionReq("sessions.patch", { key, label }, options);
  function expectDenied(result: unknown, action: "reset" | "patch", key: string) {
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `Plugin "memory-core" cannot ${action} session "${key}" because it did not create it.`,
      },
    });
  }

  const seed = (pluginOwnerId = "memory-core") =>
    writeSessionStore({ entries: { [sessionKey]: ownedEntry(pluginOwnerId) } });

  test("sessions.reset prevents a plugin from resetting another plugin's session", async () => {
    await seed("other-plugin");
    const reset = await directSessionReq("sessions.reset", { key: sessionKey }, writeOptions);
    expectDenied(reset, "reset", sessionKey);
    expect(readEntry()).toMatchObject({ sessionId, pluginOwnerId: "other-plugin" });
  });

  test("sessions.reset stamps plugin ownership when it materializes a missing session", async () => {
    const reset = await directSessionReq("sessions.reset", { key: sessionKey }, writeOptions);

    expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
    expect(readEntry()).toMatchObject({ pluginOwnerId: "memory-core" });

    const patched = await patch(sessionKey, "Reset-created plugin session", writeOptions);

    expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
  });

  test("sessions.reset rechecks plugin ownership inside lifecycle admission", async () => {
    await seed();
    const { performGatewaySessionReset } = await import("./session-reset-service.js");
    let replaced = false;

    const reset = await performGatewaySessionReset({
      key: sessionKey,
      reason: "reset",
      commandSource: "gateway:sessions.reset",
      workerPlacementContext: {},
      authorizedPluginId: "memory-core",
      assertCurrent: () => {
        if (replaced) {
          return;
        }
        replaced = true;
        replaceSessionEntrySync({ sessionKey, storePath }, ownedEntry("other-plugin"));
      },
    });

    expectDenied(reset, "reset", sessionKey);
    expect(readEntry()).toMatchObject({ pluginOwnerId: "other-plugin", sessionId });
  });

  test("sessions.patch limits plugin-runtime mutations to sessions owned by that plugin", async () => {
    const foreignKey = "agent:main:dreaming-narrative-foreign";
    const operatorKey = "agent:main:dashboard:operator-owned";
    await writeSessionStore({
      entries: {
        [sessionKey]: ownedEntry(),
        [foreignKey]: sessionStoreEntry("sess-foreign", { pluginOwnerId: "other-plugin" }),
        [operatorKey]: sessionStoreEntry("sess-operator"),
      },
    });
    for (const key of [foreignKey, operatorKey]) {
      const denied = await patch(key, "unauthorized mutation");
      expectDenied(denied, "patch", key);
      expect(readEntry(key)?.label).toBeUndefined();
    }

    const patched = await patch(sessionKey, "authorized mutation");

    expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
    expect(readEntry()?.label).toBe("authorized mutation");
  });

  test("sessions.patch rechecks plugin ownership after waiting for lifecycle admission", async () => {
    await seed();
    const releaseMutation = createDeferred();
    const { promise: mutationStarted, resolve: markMutationStarted } = createDeferred();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        markMutationStarted();
        await releaseMutation.promise;
      },
    });
    await mutationStarted;
    const pendingPatch = patch(sessionKey, "unauthorized raced mutation");
    await Promise.resolve();
    await replaceSessionEntry({ sessionKey, storePath }, ownedEntry("other-plugin"));
    releaseMutation.resolve();

    const [patched] = await Promise.all([pendingPatch, mutation]);

    expectDenied(patched, "patch", sessionKey);
    expect(readEntry()).toMatchObject({ pluginOwnerId: "other-plugin" });
    expect(readEntry()?.label).toBeUndefined();
  });
});
