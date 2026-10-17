import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  readSessionMembersInWorker,
} from "../config/sessions/session-sharing-store.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { forgetActiveSessionForShutdown } from "./active-sessions-shutdown-tracker.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleChatMetadataRequest } from "./server-methods/chat-metadata-handler.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import {
  createSubscriptionTestFixture,
  registerSubscriptionChatRun,
} from "./server-runtime-subscriptions.test-support.js";

vi.mock("../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => ({
    record: vi.fn(),
    recordTool: vi.fn(),
    recordMessage: vi.fn(),
    recordExecutionIdentity: vi.fn(),
    recordExecutionDecision: vi.fn(),
    recordExecutionDecisionWork: vi.fn(),
    stop: vi.fn(async () => {}),
  }),
}));

const initialEntry = { sessionId: "same-session", lifecycleRevision: "before", updatedAt: 1 };
const resetEntry = { ...initialEntry, lifecycleRevision: "after", updatedAt: 2 };
type Mutation = Omit<
  Parameters<typeof applySessionEntryLifecycleMutation>[0],
  "agentId" | "storePath"
>;

function createAccessFixture(state: OpenClawTestState) {
  setRuntimeConfigSnapshot({});
  const store = {
    agentId: "main",
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
  };
  const scope = { ...store, sessionKey: "agent:main:identity-access" };
  const params = createSubscriptionTestFixture().createParams();
  const subscriptions: ReturnType<typeof startGatewayEventSubscriptions>[] = [];
  return {
    scope,
    params,
    store,
    workspaceDir: state.workspaceDir,
    mutate: (mutation: Mutation) =>
      applySessionEntryLifecycleMutation({ ...store, skipMaintenance: true, ...mutation }),
    start() {
      const subscription = startGatewayEventSubscriptions(params);
      subscriptions.push(subscription);
      return subscription;
    },
    async [Symbol.asyncDispose]() {
      for (const subscription of subscriptions) {
        await subscription.agentUnsub();
        subscription.heartbeatUnsub();
        subscription.transcriptUnsub();
        subscription.lifecycleUnsub();
      }
    },
  };
}

async function withAccessFixture(
  body: (fixture: ReturnType<typeof createAccessFixture>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await using fixture = createAccessFixture(state);
    await body(fixture);
  });
}

it("invalidates access synchronously for committed create, move, reset, and delete", async () => {
  await withAccessFixture(async ({ scope, store, mutate, start }) => {
    start();
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
    const revision = readGatewayAccessRevision();
    const changes: Array<{ kind: string; revision: number; inTransaction: boolean }> = [];
    const observe = onSessionIdentityMutation((mutation) => {
      changes.push({
        kind: mutation.kind,
        revision: readGatewayAccessRevision(),
        inTransaction: database.db.isTransaction,
      });
    });
    try {
      await upsertSessionEntryCore(scope, { ...initialEntry });
      const movedKey = "agent:main:moved-identity-access";
      await mutate({
        removals: [{ sessionKey: scope.sessionKey }],
        upserts: [{ sessionKey: movedKey, entry: initialEntry }],
      });
      await resetSessionEntryLifecycle({
        ...store,
        target: { canonicalKey: movedKey, storeKeys: [movedKey] },
        buildNextEntry: () => ({ ...resetEntry }),
      });
      expect(loadSessionEntry({ ...scope, sessionKey: movedKey })).toMatchObject({
        sessionId: initialEntry.sessionId,
        lifecycleRevision: "after",
      });
      await mutate({ removals: [{ sessionKey: movedKey }] });
      expect(changes.map((change) => change.kind)).toEqual(["create", "move", "reset", "delete"]);
      for (const [index, change] of changes.entries()) {
        expect(change.inTransaction).toBe(false);
        expect(change.revision).toBeGreaterThan(changes[index - 1]?.revision ?? revision);
      }
    } finally {
      observe();
    }
  });
});

it("keeps concurrent draft and saved metadata reads available while another session is created", async () => {
  await withAccessFixture(async ({ scope, start }) => {
    await upsertSessionEntryCore(scope, { sessionId: "selected", updatedAt: 1 });
    start();
    const metadata = { commands: [], models: [], swarmEnabled: false };
    const readerCount = 50;
    const entered = createDeferred();
    const release = createDeferred();
    let enteredReaders = 0;
    const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async () => {
      if (++enteredReaders === readerCount) {
        entered.resolve();
      }
      await release.promise;
      return metadata;
    });
    const context = createDirectChatContext({ readChatMetadata });
    const readers = Array.from({ length: readerCount }, (_, index) => {
      const respond = vi.fn<RespondFn>();
      const pending = handleChatMetadataRequest({
        req: { type: "req", id: `metadata-${index}`, method: "chat.metadata" },
        params: index % 2 === 0 ? { sessionKey: scope.sessionKey } : { agentId: scope.agentId },
        context,
        client: null,
        respond,
        isWebchatConnect: () => false,
      });
      return { respond, pending };
    });
    const settled = Promise.allSettled(readers.map(({ pending }) => pending));
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        Promise.race(readers.map(({ pending }) => pending)),
        "Metadata request settled before all readers entered",
      );
      expect(readChatMetadata).toHaveBeenCalledTimes(readers.length);
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:unrelated-creation" },
        { sessionId: "unrelated", updatedAt: 1 },
      );
    } finally {
      release.resolve();
      await settled;
    }
    expect((await settled).filter((result) => result.status === "rejected")).toEqual([]);
    for (const { respond } of readers) {
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, metadata);
    }
  });
});

it.each([
  { mode: "batched", rollback: false },
  { mode: "batched", rollback: true },
  { mode: "outer transaction", rollback: false },
  { mode: "outer transaction", rollback: true },
])(
  "publishes a same-ID reset only after $mode commits (rollback: $rollback)",
  async ({ mode, rollback }) => {
    await withAccessFixture(async ({ scope, workspaceDir, mutate, start }) => {
      await upsertSessionEntryCore(scope, { ...initialEntry });
      start();
      const revision = readGatewayAccessRevision();
      if (mode === "outer transaction") {
        await patchSessionEntryCore(scope, () => ({ label: "metadata only" }));
        expect(readGatewayAccessRevision()).toBe(revision);
        const replace = () =>
          runOpenClawAgentWriteTransaction(
            () => {
              replaceSessionEntrySync(scope, { ...resetEntry });
              expect(readGatewayAccessRevision()).toBe(revision);
              if (rollback) {
                throw new Error("rollback identity");
              }
            },
            { agentId: scope.agentId, path: scope.storePath },
          );
        if (rollback) {
          expect(replace).toThrow("rollback identity");
        } else {
          replace();
        }
      } else {
        const kinds: string[] = [];
        const observe = onSessionIdentityMutation((mutation) => kinds.push(mutation.kind));
        try {
          const reset = mutate({
            activeSessionKey: scope.sessionKey,
            upserts: [
              {
                sessionKey: scope.sessionKey,
                entry: {
                  ...resetEntry,
                  ...(rollback ? { parentSessionKey: "invalid-reset-parent" } : {}),
                },
                resetBoundary: { context: "preserve-tail", reason: "reset", cwd: workspaceDir },
              },
            ],
          });
          if (rollback) {
            await expect(reset).rejects.toThrow(
              "refusing non-canonical session key write invalid-reset-parent",
            );
          } else {
            await reset;
          }
          expect(kinds).toEqual(rollback ? [] : ["reset"]);
        } finally {
          observe();
        }
      }
      if (rollback) {
        expect(readGatewayAccessRevision()).toBe(revision);
      } else {
        expect(readGatewayAccessRevision()).toBeGreaterThan(revision);
      }
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: initialEntry.sessionId,
        lifecycleRevision: rollback ? "before" : "after",
      });
    });
  },
);

it("invalidates committed compaction access after the run is aborted and removed", async () => {
  await withAccessFixture(async ({ scope, params, start }) => {
    const entry = {
      sessionId: "predecessor",
      lifecycleRevision: "current-lifecycle",
      activeWriterRunId: undefined,
      updatedAt: 1,
      visibility: "shared" as const,
    };
    await upsertSessionEntryCore(scope, entry);
    await addSessionMember(scope, { identityId: "member", addedBy: "owner" });
    const runId = "compaction-agent";
    const run = registerSubscriptionChatRun(params, {
      runId,
      ...scope,
      sessionId: entry.sessionId,
      kind: "agent",
    });
    // An earlier identity observer can retire the live caller after COMMIT.
    const abort = onSessionIdentityMutation((mutation) => {
      if (mutation.kind === "replace" && mutation.previous.sessionId === entry.sessionId) {
        run.entry.controller.abort();
        run.cleanup();
      }
    });
    start();
    const revision = readGatewayAccessRevision();
    try {
      const input = {
        currentTarget: { ...scope, sessionId: entry.sessionId },
        expectedEntry: entry,
        assertActive: () => run.entry.controller.signal.throwIfAborted(),
        config: {},
      };
      await acceptCompactionSuccessor({ ...input, result: { ok: true, compacted: true } });
      expect(readGatewayAccessRevision()).toBe(revision);
      const committed = await acceptCompactionSuccessor({
        ...input,
        result: {
          ok: true,
          compacted: true,
          result: { tokensBefore: 4_096, sessionId: "successor" },
        },
      });
      expect(committed.entry.sessionId).toBe("successor");
      expect(run.entry.controller.signal.aborted).toBe(true);
      expect(params.chatAbortControllers.has(runId)).toBe(false);
      expect(readGatewayAccessRevision()).toBeGreaterThan(revision);
      expect(loadSessionEntry(scope)?.visibility).toBeUndefined();
      expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
    } finally {
      abort();
      run.cleanup();
      forgetActiveSessionForShutdown(entry.sessionId);
      forgetActiveSessionForShutdown("successor");
    }
  });
});

it("retires the identity listener with the Gateway lifecycle and installs one on restart", async () => {
  await withAccessFixture(async ({ scope, start }) => {
    const first = start();
    await upsertSessionEntryCore(scope, { sessionId: "first", updatedAt: 1 });
    await first.agentUnsub();
    const beforeDrainCompletion = readGatewayAccessRevision();
    replaceSessionEntrySync(scope, { sessionId: "drained", updatedAt: 2 });
    expect(readGatewayAccessRevision()).toBeGreaterThan(beforeDrainCompletion);
    first.heartbeatUnsub();
    first.transcriptUnsub();
    first.lifecycleUnsub();
    const stopped = readGatewayAccessRevision();
    replaceSessionEntrySync(scope, { sessionId: "stopped", updatedAt: 3 });
    expect(readGatewayAccessRevision()).toBe(stopped);
    start();
    first.lifecycleUnsub();
    replaceSessionEntrySync(scope, { sessionId: "restarted", updatedAt: 4 });
    // This primitive write has one identity publication, with no RPC notice.
    expect(readGatewayAccessRevision()).toBe(stopped + 1);
  });
});
