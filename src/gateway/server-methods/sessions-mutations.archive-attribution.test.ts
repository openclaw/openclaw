import { afterEach, expect, it, vi } from "vitest";
import type {
  SessionsPatchParams,
  SessionsPatchManyParams,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import * as lifecycleDrain from "./sessions-lifecycle-drain.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
import * as archivePreparation from "./sessions-patch-archive.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());
const scopeFor = (sessionKey: string) => ({ agentId: "main", sessionKey });
const readSession = (key: string) => loadSessionEntry(scopeFor(key));
const seedSession = (key: string, entry: Partial<SessionEntry> = {}) =>
  upsertSessionEntryCore(scopeFor(key), { sessionId: key, updatedAt: 1, ...entry });
const replyOperation = (key: string, sessionId = key) =>
  createReplyOperation({
    ...scopeFor(key),
    sessionId,
    target: captureSessionTarget({
      storeScope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      sessionKey: key,
      agentId: "main",
      incarnation: sessionId,
    }),
    resetTriggered: false,
  });
const organizationExpectation = {
  expectedSidebarRoot: false,
  expectedCategory: null,
  expectedArchived: false,
};
const expectUnarchived = (key: string, operation: ReturnType<typeof replyOperation>) =>
  expect([readSession(key)?.archivedAt, operation.abortSignal.aborted]).toEqual([undefined, false]);
const expectChanged = (responses: Parameters<RespondFn>[]) => {
  expect(responses[0]?.[0]).toBe(false);
  expect(responses[0]?.[2]?.message).toContain("changed before patch");
};

function client(profileId?: string, displayName?: string): GatewayClient {
  const requestClient = createSessionMutationTestClient(profileId);
  requestClient.connect.scopes = ["operator.read", "operator.write"];
  if (requestClient.authenticatedUserProfile) {
    requestClient.authenticatedUserProfile.displayName = displayName ?? null;
  }
  return requestClient;
}

async function patchSession(
  key: string,
  requestClient = client(),
  expectedSessionId = key,
  archived = true,
) {
  const responses = await invokePatchSession({ key, archived, expectedSessionId }, requestClient);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
}

async function invokePatchSession(
  params: SessionsPatchParams | SessionsPatchManyParams,
  requestClient = client(),
  method: "sessions.patch" | "sessions.patchMany" = "sessions.patch",
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers[method]?.({
    params,
    client: requestClient,
    context: {
      getRuntimeConfig: () => ({}),
      loadGatewayModelCatalogSnapshot: vi.fn(async () => ({ entries: [], routeVariants: [] })),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set(),
      dedupe: new Map(),
    } as unknown as GatewayRequestContext,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  return responses;
}

it.aroundEach((runTest) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    await runTest();
  }),
);
it("drains an archive behind an unrelated writer, then commits after that writer settles", async ({
  signal,
}) => {
  const key = "agent:main:dashboard:archive-writer-wait";
  await seedSession(key, { sessionId: "archive-writer-wait" });
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const drained = createDeferredCore();
  let writer: Promise<void> | undefined;
  const prepareOwner = archivePreparation.prepareSessionPatchArchive;
  const drainOwner = lifecycleDrain.prepareSessionLifecycleDrain;
  const prepare = vi
    .spyOn(archivePreparation, "prepareSessionPatchArchive")
    .mockImplementationOnce(async (params) => {
      writer = runOpenClawAgentWriteAdmission(
        { agentId: "main", path: params.target.initialTarget.readSource!.path },
        async () => {
          entered.resolve();
          await resume.promise;
        },
      );
      await entered.promise;
      return prepareOwner(params);
    });
  const drain = vi
    .spyOn(lifecycleDrain, "prepareSessionLifecycleDrain")
    .mockImplementationOnce(async (params) => {
      const result = await drainOwner(params);
      drained.resolve();
      return result;
    });
  const patch = invokePatchSession({
    key,
    archived: true,
    expectedSessionId: "archive-writer-wait",
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(drained.promise, patch, "Archive settled before draining"),
      signal,
    );
    expect(readSession(key)?.archivedAt).toBeUndefined();
    resume.resolve();
    expect((await patch)[0]?.[0]).toBe(true);
    expect(readSession(key)?.archivedAt).toEqual(expect.any(Number));
  } finally {
    resume.resolve();
    await Promise.allSettled([patch, ...(writer ? [writer] : [])]);
    prepare.mockRestore();
    drain.mockRestore();
  }
});

it.each([
  { change: { sidebarRoot: true }, name: "promotion" },
  { change: { category: "Independent" }, name: "category" },
  { change: { archivedAt: 42 }, name: "archive" },
])("rejects a $name race before drain and in the drain's live guard", async ({ change }) => {
  const key = "agent:main:dashboard:archive-cas";
  const entry = { sessionId: "archive-cas", updatedAt: 1, lifecycleRevision: "unchanged" };
  const patch = {
    key,
    expectedSessionId: entry.sessionId,
    expectedLifecycleRevision: entry.lifecycleRevision,
    ...organizationExpectation,
    archived: true,
  };
  const operation = replyOperation(key, entry.sessionId);
  operation.abortSignal.addEventListener("abort", () => operation.complete(), { once: true });
  const drainOwner = lifecycleDrain.prepareSessionLifecycleDrain;
  const drain = vi.spyOn(lifecycleDrain, "prepareSessionLifecycleDrain");
  try {
    await seedSession(key, { ...entry, ...change });
    const before = readSession(key);
    expectChanged(await invokePatchSession(patch));
    expect(drain).not.toHaveBeenCalled();
    expect(operation.abortSignal.aborted).toBe(false);
    expect(readSession(key)).toEqual(before);

    // Advance metadata after archive preview but before ingress closure and cancellation.
    await replaceSessionEntry(scopeFor(key), entry);
    let racedEntry: Awaited<ReturnType<typeof upsertSessionEntryCore>> = null;
    drain.mockImplementationOnce(async (params) => {
      racedEntry = await seedSession(key, { ...entry, ...change });
      return drainOwner(params);
    });
    const raced = await invokePatchSession(patch);
    expect(drain).toHaveBeenCalledOnce();
    expectChanged(raced);
    expect(operation.abortSignal.aborted).toBe(false);
    expect(racedEntry).not.toBeNull();
    expect(readSession(key)).toEqual(racedEntry);
    expect(readSession(key)?.archivedAt).toBe(
      "archivedAt" in change ? change.archivedAt : undefined,
    );
  } finally {
    drain.mockRestore();
    operation.complete();
  }
});

it.each([{ sidebarRoot: true }, { category: "Independent" }, { archivedAt: 42 }])(
  "checks organization CAS in the admitted writer for ordinary patches: %j",
  async (change) => {
    const key = "agent:main:dashboard:writer-cas";
    await seedSession(key, { label: "Original", ...change });
    const before = readSession(key);
    const responses = await invokePatchSession({
      key,
      expectedSessionId: key,
      ...organizationExpectation,
      label: "Must not overwrite",
    });
    expectChanged(responses);
    expect(readSession(key)).toEqual(before);
  },
);

it("preserves a grandchild through hidden runs when its persistent ancestor becomes independent", async () => {
  const root = "agent:main:dashboard:tree-root";
  const child = "agent:main:dashboard:tree-child";
  const hidden = "agent:main:subagent:tree-bridge";
  const grandchild = "agent:main:dashboard:tree-grandchild";
  for (const [key, parentSessionKey] of [
    [root, undefined],
    [child, root],
    [hidden, child],
    [grandchild, hidden],
  ]) {
    await seedSession(key!, { parentSessionKey });
  }
  const ancestors = [child, root].map((key) => ({
    key,
    expectedSessionId: key,
    expectedSidebarRoot: false,
    expectedCategory: null,
  }));
  const patch = {
    key: grandchild,
    expectedSessionId: grandchild,
    archived: true,
    expectedSidebarAncestors: ancestors,
  };
  const operation = replyOperation(grandchild);
  operation.abortSignal.addEventListener("abort", () => operation.complete(), { once: true });
  const drainOwner = lifecycleDrain.prepareSessionLifecycleDrain;
  const drain = vi.spyOn(lifecycleDrain, "prepareSessionLifecycleDrain");
  try {
    await upsertSessionEntryCore(scopeFor(child), { sidebarRoot: true });
    expect((await invokePatchSession(patch))[0]?.[0]).toBe(false);
    expect(drain).not.toHaveBeenCalled();
    expectUnarchived(grandchild, operation);

    await upsertSessionEntryCore(scopeFor(child), { sidebarRoot: undefined });
    drain.mockImplementationOnce(async (params) => {
      await upsertSessionEntryCore(scopeFor(child), { category: "Independent" });
      return drainOwner(params);
    });
    const raced = await invokePatchSession(patch);
    expect(drain).toHaveBeenCalledOnce();
    expectChanged(raced);
    expectUnarchived(grandchild, operation);

    drain.mockRestore();
    await upsertSessionEntryCore(scopeFor(child), { category: undefined });
    for (const ancestor of [child, hidden]) {
      await upsertSessionEntryCore(scopeFor(ancestor), { archivedAt: 42 });
      expectChanged(await invokePatchSession(patch));
      expectUnarchived(grandchild, operation);
      await upsertSessionEntryCore(scopeFor(ancestor), { archivedAt: undefined });
    }
    operation.complete();
    expect((await invokePatchSession(patch))[0]?.[0]).toBe(true);
    expect(readSession(grandchild)?.archivedAt).toEqual(expect.any(Number));
  } finally {
    drain.mockRestore();
    operation.complete();
  }
});

it("returns per-target batch outcomes without acquiring independently archived rows", async () => {
  const keys = ["agent:main:dashboard:cas-independent", "agent:main:dashboard:cas-selected"];
  for (const [index, key] of keys.entries()) {
    await seedSession(key, index === 0 ? { archivedAt: 42 } : {});
  }
  const responses = await invokePatchSession(
    {
      targets: keys.map((key) => ({
        key,
        expectedSessionId: key,
        ...organizationExpectation,
      })),
      patch: { archived: true },
    },
    client(),
    "sessions.patchMany",
  );
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
  expect(responses[0]?.[1]).toMatchObject({
    outcomes: [
      {
        key: keys[0],
        ok: false,
        error: { message: expect.stringContaining("changed before patch") },
      },
      { key: keys[1], ok: true },
    ],
  });
  expect(readSession(keys[0]!)?.archivedAt).toBe(42);
  expect(readSession(keys[1]!)?.archivedAt).toEqual(expect.any(Number));
});

it("archives only the selected conversation, preserving nested and promoted child work", async () => {
  const parent = "agent:main:dashboard:archive-parent";
  await seedSession(parent, { sessionId: "parent" });
  const children = [];
  for (const sidebarRoot of [false, true]) {
    const key = parent + (sidebarRoot ? "-promoted" : "-nested");
    const committed = await seedSession(key, {
      parentSessionKey: parent,
      spawnedBy: parent,
      sidebarRoot,
    });
    expect(committed).not.toBeNull();
    children.push({ key, entry: committed, operation: replyOperation(key) });
  }
  try {
    await patchSession(parent, client(), "parent");
    expect(readSession(parent)?.archivedAt).toEqual(expect.any(Number));
    for (const { key, entry, operation } of children) {
      expect(readSession(key)).toEqual(entry);
      expectUnarchived(key, operation);
    }
  } finally {
    for (const { operation } of children) {
      operation.complete();
    }
  }
});
it.each([
  { endedAt: undefined, identified: true },
  { endedAt: 20, identified: true },
  { endedAt: 20, identified: false },
])(
  "retains terminal state and attribution (identified=$identified, endedAt=$endedAt)",
  async ({ endedAt, identified }) => {
    const sessionKey = identified ? "agent:main:archive-attribution" : "agent:main:solo-archive";
    const sessionId = identified ? "session-archive-attribution" : "session-solo-archive";
    const retained = identified
      ? {
          mainRestartRecovery: { cycleId: "interrupted-cycle", revision: 1, chargedAttempts: 0 },
          restartRecoveryRuns: [{ runId: "interrupted-run", lifecycleGeneration: "previous-boot" }],
          restartRecoveryTerminalRunIds: ["delivered-run"],
          pendingFinalDelivery: {
            kind: "replayable" as const,
            text: "Retained final",
            createdAt: 15,
          },
          lastRunId: "previous-terminal-client-run",
          abortedLastRun: true,
        }
      : { abortedLastRun: false, lastRunId: "failed-run", lastRunError: "Execution failed" };
    const terminal = {
      ...retained,
      status: identified ? ("interrupted" as const) : ("failed" as const),
      startedAt: 10,
      ...(endedAt === undefined ? {} : { endedAt, runtimeMs: 10 }),
    };
    await seedSession(sessionKey, {
      sessionId,
      ...terminal,
      ...(identified ? { pinnedAt: 2 } : {}),
    });
    await patchSession(sessionKey, identified ? client("profile-ada", "Ada") : client(), sessionId);
    const archived = readSession(sessionKey);
    expect(archived).toMatchObject({ ...terminal, archivedAt: expect.any(Number) });
    if (identified) {
      const ada = { type: "human", id: "profile-ada", label: "Ada" };
      expect(archived).toMatchObject({ archivedBy: ada });
      expect([archived?.lifecycleRunId, archived?.endedAt, archived?.runtimeMs]).toEqual([
        undefined,
        endedAt,
        endedAt === undefined ? undefined : 10,
      ]);

      await patchSession(sessionKey, client("profile-bob", "Bob"), sessionId);
      expect(readSession(sessionKey)?.archivedBy).toEqual(ada);

      await patchSession(sessionKey, client("profile-bob", "Bob"), sessionId, false);
      const restored = readSession(sessionKey);
      expect([restored?.archivedAt, restored?.archivedBy]).toEqual([undefined, undefined]);
      expect(restored).toMatchObject(terminal);
    } else {
      expect(archived?.archivedBy).toBeUndefined();
    }
    expect(await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey })).toEqual([]);
  },
);

it("archives through an alias with attribution", async () => {
  const canonicalKey = "agent:main:alias-happy-archive";
  const aliasKey = "alias-happy-archive";
  await seedSession(canonicalKey, { sessionId: "session-canonical-happy-archive" });
  await seedSession(aliasKey, { sessionId: "session-alias-happy-archive", updatedAt: 2 });

  const projection = await createSessionRowProjection({ cfg: {} });
  try {
    await patchSession(aliasKey, client("profile-ada", "Ada"), "session-alias-happy-archive");
    const query = { key: canonicalKey, agentId: "main" };
    await withReadySessionRows(
      projection,
      () => [query],
      () =>
        expect(projection.snapshot(query).row).toMatchObject({
          archived: true,
          archivedAt: expect.any(Number),
          archivedBy: { type: "human", id: "profile-ada" },
        }),
    );
  } finally {
    projection.dispose();
  }
});
