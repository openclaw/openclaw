import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import * as lifecycleDrain from "./sessions-lifecycle-drain.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import * as archivePreparation from "./sessions-patch-archive.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});
const scopeFor = (sessionKey: string) => ({ agentId: "main", sessionKey });
const readSession = (key: string) => loadSessionEntry(scopeFor(key));
const seedSession = (key: string, entry: Partial<SessionEntry> = {}) =>
  upsertSessionEntryCore(scopeFor(key), { sessionId: key, updatedAt: 1, ...entry });
const withArchiveState = (run: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    await run();
  });
const replyOperation = (key: string, sessionId = key) =>
  createReplyOperation({ ...scopeFor(key), sessionId, resetTriggered: false });
const expectChanged = (responses: Parameters<RespondFn>[]) => {
  expect(responses[0]?.[0]).toBe(false);
  expect(responses[0]?.[2]?.message).toContain("changed before patch");
};

function client(profileId?: string, displayName?: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    ...(profileId
      ? {
          authenticatedUserId: `${profileId}@example.com`,
          authenticatedUserProfile: {
            profileId,
            displayName: displayName ?? null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

function context(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    loadGatewayModelCatalogSnapshot: vi.fn(async () => ({ entries: [], routeVariants: [] })),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

async function patchSession(
  params: { key: string; archived: boolean; expectedSessionId: string; label?: string },
  requestClient: GatewayClient,
) {
  const responses = await invokePatchSession(params, requestClient);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
}

async function invokePatchSession(params: SessionsPatchParams, requestClient: GatewayClient) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers["sessions.patch"]?.({
    params,
    client: requestClient,
    context: context(),
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  return responses;
}

describe("sessions.patch archive attribution", () => {
  it("drains an archive behind an unrelated writer, then commits after that writer settles", async ({
    signal,
  }) => {
    await withArchiveState(async () => {
      const key = "agent:main:dashboard:archive-writer-wait";
      const scope = { agentId: "main", sessionKey: key };
      await upsertSessionEntryCore(scope, { sessionId: "archive-writer-wait", updatedAt: 1 });
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
      const patch = invokePatchSession(
        { key, archived: true, expectedSessionId: "archive-writer-wait" },
        client(),
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(drained.promise, patch, "Archive settled before draining"),
          signal,
        );
        expect(loadSessionEntry(scope)?.archivedAt).toBeUndefined();
        resume.resolve();
        expect((await patch)[0]?.[0]).toBe(true);
        expect(loadSessionEntry(scope)?.archivedAt).toEqual(expect.any(Number));
      } finally {
        resume.resolve();
        await Promise.allSettled([patch, ...(writer ? [writer] : [])]);
        prepare.mockRestore();
        drain.mockRestore();
      }
    });
  });

  it.each([
    { change: { sidebarRoot: true }, name: "promotion" },
    { change: { category: "Independent" }, name: "category" },
    { change: { archivedAt: 42 }, name: "archive" },
  ])("rejects a $name race before drain and in the drain's live guard", async ({ change }) => {
    await withArchiveState(async () => {
      const key = "agent:main:dashboard:archive-cas";
      const scope = { agentId: "main", sessionKey: key };
      const entry = { sessionId: "archive-cas", updatedAt: 1, lifecycleRevision: "unchanged" };
      const patch = {
        key,
        expectedSessionId: entry.sessionId,
        expectedLifecycleRevision: entry.lifecycleRevision,
        expectedSidebarRoot: false,
        expectedCategory: null,
        expectedArchived: false,
        archived: true,
      };
      const operation = replyOperation(key, entry.sessionId);
      operation.abortSignal.addEventListener("abort", () => operation.complete(), { once: true });
      const drainOwner = lifecycleDrain.prepareSessionLifecycleDrain;
      const drain = vi.spyOn(lifecycleDrain, "prepareSessionLifecycleDrain");
      try {
        await upsertSessionEntryCore(scope, { ...entry, ...change });
        const before = loadSessionEntry(scope);
        const refused = await invokePatchSession(patch, client());
        expectChanged(refused);
        expect(drain).not.toHaveBeenCalled();
        expect(operation.abortSignal.aborted).toBe(false);
        expect(loadSessionEntry(scope)).toEqual(before);

        // Advance metadata after archive preview but before ingress closure and cancellation.
        await replaceSessionEntry(scope, entry);
        let racedEntry: Awaited<ReturnType<typeof upsertSessionEntryCore>> = null;
        drain.mockImplementationOnce(async (params) => {
          racedEntry = await upsertSessionEntryCore(scope, { ...entry, ...change });
          return drainOwner(params);
        });
        const raced = await invokePatchSession(patch, client());
        expect(drain).toHaveBeenCalledOnce();
        expectChanged(raced);
        expect(operation.abortSignal.aborted).toBe(false);
        expect(racedEntry).not.toBeNull();
        expect(loadSessionEntry(scope)).toEqual(racedEntry);
        expect(loadSessionEntry(scope)?.archivedAt).toBe(
          "archivedAt" in change ? change.archivedAt : undefined,
        );
      } finally {
        drain.mockRestore();
        operation.complete();
      }
    });
  });

  it.each([{ sidebarRoot: true }, { category: "Independent" }, { archivedAt: 42 }])(
    "checks organization CAS in the admitted writer for ordinary patches: %j",
    async (change) => {
      await withArchiveState(async () => {
        const key = "agent:main:dashboard:writer-cas";
        const scope = { agentId: "main", sessionKey: key };
        await upsertSessionEntryCore(scope, {
          sessionId: key,
          updatedAt: 1,
          label: "Original",
          ...change,
        });
        const before = loadSessionEntry(scope);
        const responses = await invokePatchSession(
          {
            key,
            expectedSessionId: key,
            expectedSidebarRoot: false,
            expectedCategory: null,
            expectedArchived: false,
            label: "Must not overwrite",
          },
          client(),
        );
        expectChanged(responses);
        expect(loadSessionEntry(scope)).toEqual(before);
      });
    },
  );

  it("preserves a grandchild through hidden runs when its persistent ancestor becomes independent", async () => {
    await withArchiveState(async () => {
      const root = "agent:main:dashboard:tree-root";
      const child = "agent:main:dashboard:tree-child";
      const hidden = "agent:main:subagent:tree-bridge";
      const grandchild = "agent:main:dashboard:tree-grandchild";
      const scope = (key: string) => ({ agentId: "main", sessionKey: key });
      for (const [key, parentSessionKey] of [
        [root, undefined],
        [child, root],
        [hidden, child],
        [grandchild, hidden],
      ]) {
        await upsertSessionEntryCore(scope(key!), {
          sessionId: key!,
          updatedAt: 1,
          parentSessionKey,
        });
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
        await upsertSessionEntryCore(scope(child), { sidebarRoot: true });
        expect((await invokePatchSession(patch, client()))[0]?.[0]).toBe(false);
        expect(drain).not.toHaveBeenCalled();
        expect(operation.abortSignal.aborted).toBe(false);
        expect(loadSessionEntry(scope(grandchild))?.archivedAt).toBeUndefined();

        await upsertSessionEntryCore(scope(child), { sidebarRoot: undefined });
        drain.mockImplementationOnce(async (params) => {
          await upsertSessionEntryCore(scope(child), { category: "Independent" });
          return drainOwner(params);
        });
        const raced = await invokePatchSession(patch, client());
        expect(drain).toHaveBeenCalledOnce();
        expectChanged(raced);
        expect(operation.abortSignal.aborted).toBe(false);
        expect(loadSessionEntry(scope(grandchild))?.archivedAt).toBeUndefined();

        drain.mockRestore();
        await upsertSessionEntryCore(scope(child), { category: undefined });
        for (const ancestor of [child, hidden]) {
          await upsertSessionEntryCore(scope(ancestor), { archivedAt: 42 });
          const archivedAncestor = await invokePatchSession(patch, client());
          expectChanged(archivedAncestor);
          expect(operation.abortSignal.aborted).toBe(false);
          expect(loadSessionEntry(scope(grandchild))?.archivedAt).toBeUndefined();
          await upsertSessionEntryCore(scope(ancestor), { archivedAt: undefined });
        }
        operation.complete();
        expect((await invokePatchSession(patch, client()))[0]?.[0]).toBe(true);
        expect(loadSessionEntry(scope(grandchild))?.archivedAt).toEqual(expect.any(Number));
      } finally {
        drain.mockRestore();
        operation.complete();
      }
    });
  });

  it("returns per-target batch outcomes without acquiring independently archived rows", async () => {
    await withArchiveState(async () => {
      const keys = ["agent:main:dashboard:cas-independent", "agent:main:dashboard:cas-selected"];
      for (const [index, key] of keys.entries()) {
        await seedSession(key, index === 0 ? { archivedAt: 42 } : {});
      }
      const responses: Parameters<RespondFn>[] = [];
      await sessionMutationHandlers["sessions.patchMany"]?.({
        params: {
          targets: keys.map((key) => ({
            key,
            expectedSessionId: key,
            expectedSidebarRoot: false,
            expectedCategory: null,
            expectedArchived: false,
          })),
          patch: { archived: true },
        },
        client: client(),
        context: context(),
        respond: (...response: Parameters<RespondFn>) => responses.push(response),
      } as never);
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
  });

  it("archives only the selected conversation, preserving nested and promoted child work", async () => {
    await withArchiveState(async () => {
      const parent = "agent:main:dashboard:archive-parent";
      await seedSession(parent, { sessionId: "parent" });
      const children = [];
      for (const sidebarRoot of [false, true]) {
        const key = parent + (sidebarRoot ? "-promoted" : "-nested");
        const entry = {
          sessionId: key,
          updatedAt: 1,
          parentSessionKey: parent,
          spawnedBy: parent,
          sidebarRoot,
        };
        const committed = await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
        expect(committed).not.toBeNull();
        const operation = replyOperation(key);
        children.push({ key, entry: committed, operation });
      }
      try {
        await patchSession({ key: parent, archived: true, expectedSessionId: "parent" }, client());
        expect(readSession(parent)?.archivedAt).toEqual(expect.any(Number));
        for (const { key, entry, operation } of children) {
          const stored = readSession(key);
          expect(stored).toEqual(entry);
          expect(stored?.archivedAt).toBeUndefined();
          expect(operation.abortSignal.aborted).toBe(false);
        }
      } finally {
        for (const { operation } of children) {
          operation.complete();
        }
      }
    });
  });
  it.each([undefined, 20])(
    "preserves the interruption outcome, receipts, and first archiver (endedAt=%s)",
    async (endedAt) => {
      await withArchiveState(async () => {
        const sessionKey = "agent:main:archive-attribution";
        const sessionId = "session-archive-attribution";
        const retained = {
          mainRestartRecovery: { cycleId: "interrupted-cycle", revision: 1, chargedAttempts: 0 },
          restartRecoveryRuns: [{ runId: "interrupted-run", lifecycleGeneration: "previous-boot" }],
          restartRecoveryTerminalRunIds: ["delivered-run"],
          pendingFinalDelivery: {
            kind: "replayable" as const,
            text: "Retained final",
            createdAt: 15,
          },
          lastRunId: "previous-terminal-client-run",
          ...(endedAt === undefined ? {} : { endedAt, runtimeMs: 10 }),
        };
        await seedSession(sessionKey, {
          sessionId,
          pinnedAt: 2,
          status: "interrupted",
          startedAt: 10,
          abortedLastRun: true,
          ...retained,
        });

        await patchSession(
          { key: sessionKey, archived: true, expectedSessionId: sessionId },
          client("profile-ada", "Ada"),
        );
        expect(readSession(sessionKey)).toMatchObject({
          ...retained,
          status: "interrupted",
          abortedLastRun: true,
          archivedAt: expect.any(Number),
          archivedBy: { type: "human", id: "profile-ada", label: "Ada" },
        });
        expect(readSession(sessionKey)?.lifecycleRunId).toBeUndefined();
        expect(readSession(sessionKey)?.endedAt).toBe(endedAt);
        expect(readSession(sessionKey)?.runtimeMs).toBe(endedAt === undefined ? undefined : 10);

        await patchSession(
          { key: sessionKey, archived: true, expectedSessionId: sessionId },
          client("profile-bob", "Bob"),
        );
        expect(readSession(sessionKey)?.archivedBy).toEqual({
          type: "human",
          id: "profile-ada",
          label: "Ada",
        });

        await patchSession(
          { key: sessionKey, archived: false, expectedSessionId: sessionId },
          client("profile-bob", "Bob"),
        );
        const restored = readSession(sessionKey);
        expect(restored?.archivedAt).toBeUndefined();
        expect(restored?.archivedBy).toBeUndefined();
        expect(restored).toMatchObject({ ...retained, status: "interrupted" });

        expect(await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey })).toEqual([]);
      });
    },
  );

  it("does not fabricate attribution or transcript events for an unidentified client", async () => {
    await withArchiveState(async () => {
      const sessionKey = "agent:main:solo-archive";
      const sessionId = "session-solo-archive";
      const terminal = {
        status: "failed" as const,
        startedAt: 10,
        endedAt: 20,
        runtimeMs: 10,
        abortedLastRun: false,
        lastRunId: "failed-run",
        lastRunError: "Execution failed",
      };
      await seedSession(sessionKey, { sessionId, ...terminal });

      await patchSession(
        { key: sessionKey, archived: true, expectedSessionId: sessionId },
        client(),
      );

      const archived = readSession(sessionKey);
      expect(archived).toMatchObject(terminal);
      expect(archived?.archivedAt).toEqual(expect.any(Number));
      expect(archived?.archivedBy).toBeUndefined();
      expect(await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey })).toEqual([]);
    });
  });

  it("archives through an alias with attribution", async () => {
    await withArchiveState(async () => {
      const canonicalKey = "agent:main:alias-happy-archive";
      const aliasKey = "alias-happy-archive";
      await seedSession(canonicalKey, { sessionId: "session-canonical-happy-archive" });
      await seedSession(aliasKey, { sessionId: "session-alias-happy-archive", updatedAt: 2 });

      const projection = await createSessionRowProjection({ cfg: {} });
      try {
        await patchSession(
          {
            key: aliasKey,
            archived: true,
            expectedSessionId: "session-alias-happy-archive",
          },
          client("profile-ada", "Ada"),
        );
        const query = { key: canonicalKey, agentId: "main" };
        await withReadySessionRows(
          projection,
          () => [query],
          () => {
            expect(projection.snapshot(query).row).toMatchObject({
              archived: true,
              archivedAt: expect.any(Number),
              archivedBy: { type: "human", id: "profile-ada" },
            });
          },
        );
      } finally {
        projection.dispose();
      }
    });
  });
});
