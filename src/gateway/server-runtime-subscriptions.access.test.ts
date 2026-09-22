import path from "node:path";
import { expect, it, vi } from "vitest";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  patchSessionEntryCore,
  persistSessionResetLifecycle,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { addSessionMember, listSessionMembers } from "../config/sessions/session-sharing-store.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { forgetActiveSessionForShutdown } from "./active-sessions-shutdown-tracker.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
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

async function withAccessFixture(
  body: (fixture: {
    scope: { agentId: string; sessionKey: string; storePath: string };
    params: Parameters<typeof startGatewayEventSubscriptions>[0];
    workspaceDir: string;
    start: () => ReturnType<typeof startGatewayEventSubscriptions>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:identity-access",
      storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    const params = createSubscriptionTestFixture().createParams();
    const subscriptions: ReturnType<typeof startGatewayEventSubscriptions>[] = [];
    try {
      await body({
        scope,
        params,
        workspaceDir: state.workspaceDir,
        start: () => {
          const subscription = startGatewayEventSubscriptions(params);
          subscriptions.push(subscription);
          return subscription;
        },
      });
    } finally {
      for (const subscription of subscriptions) {
        await subscription.agentUnsub();
        subscription.heartbeatUnsub();
        subscription.transcriptUnsub();
        subscription.lifecycleUnsub();
        await subscription.taskUnsub();
      }
    }
  });
}

it("invalidates access synchronously for committed create, move, reset, and delete", async () => {
  await withAccessFixture(async ({ scope, start }) => {
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
      const entry = { sessionId: "same-session", lifecycleRevision: "before", updatedAt: 1 };
      await upsertSessionEntryCore(scope, entry);
      const movedKey = "agent:main:moved-identity-access";
      await applySessionEntryLifecycleMutation({
        agentId: scope.agentId,
        storePath: scope.storePath,
        removals: [{ sessionKey: scope.sessionKey }],
        upserts: [{ sessionKey: movedKey, entry }],
        skipMaintenance: true,
      });
      await resetSessionEntryLifecycle({
        agentId: scope.agentId,
        storePath: scope.storePath,
        target: { canonicalKey: movedKey, storeKeys: [movedKey] },
        buildNextEntry: () => ({ ...entry, lifecycleRevision: "after", updatedAt: 2 }),
      });
      expect(loadSessionEntry({ ...scope, sessionKey: movedKey })).toMatchObject({
        sessionId: entry.sessionId,
        lifecycleRevision: "after",
      });
      await applySessionEntryLifecycleMutation({
        agentId: scope.agentId,
        storePath: scope.storePath,
        removals: [{ sessionKey: movedKey }],
        skipMaintenance: true,
      });
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

it.each([false, true])(
  "publishes a batched same-ID reset only after commit (rollback: %s)",
  async (rollback) => {
    await withAccessFixture(async ({ scope, workspaceDir, start }) => {
      const entry = { sessionId: "same-session", lifecycleRevision: "before", updatedAt: 1 };
      await upsertSessionEntryCore(scope, entry);
      start();
      const revision = readGatewayAccessRevision();
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
      const kinds: string[] = [];
      const observe = onSessionIdentityMutation((mutation) => kinds.push(mutation.kind));
      if (rollback) {
        database.db.exec(`CREATE TEMP TRIGGER reject_reset_entry
        BEFORE UPDATE OF entry_json ON session_nodes
        BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END;`);
      }
      try {
        const reset = persistSessionResetLifecycle({
          ...scope,
          previousEntry: entry,
          nextEntry: { ...entry, lifecycleRevision: "after", updatedAt: 2 },
          nextSessionFile: scope.sessionKey,
          workspaceDir,
        });
        if (rollback) {
          await expect(reset).rejects.toThrow("injected reset failure");
          expect(kinds).toEqual([]);
          expect(readGatewayAccessRevision()).toBe(revision);
        } else {
          await reset;
          expect(kinds).toEqual(["reset"]);
          expect(readGatewayAccessRevision()).toBeGreaterThan(revision);
        }
        expect(loadSessionEntry(scope)?.lifecycleRevision).toBe(rollback ? "before" : "after");
      } finally {
        observe();
        if (rollback) {
          database.db.exec("DROP TRIGGER reject_reset_entry");
        }
      }
    });
  },
);

it.each([false, true].flatMap((rollback) => [false, true].map((sameId) => ({ rollback, sameId }))))(
  "waits for the outer identity commit (rollback: $rollback, same ID: $sameId)",
  async ({ rollback, sameId }) => {
    await withAccessFixture(async ({ scope, start }) => {
      const entry = { sessionId: "original", lifecycleRevision: "before", updatedAt: 1 };
      await upsertSessionEntryCore(scope, entry);
      start();
      const revision = readGatewayAccessRevision();
      await patchSessionEntryCore(scope, () => ({ label: "metadata only" }));
      expect(readGatewayAccessRevision()).toBe(revision);
      const replace = () =>
        runOpenClawAgentWriteTransaction(
          () => {
            replaceSessionEntrySync(scope, {
              sessionId: sameId ? "original" : "replacement",
              lifecycleRevision: "after",
              updatedAt: 2,
            });
            expect(readGatewayAccessRevision()).toBe(revision);
            if (rollback) {
              throw new Error("rollback identity");
            }
          },
          { agentId: scope.agentId, path: scope.storePath },
        );
      if (rollback) {
        expect(replace).toThrow("rollback identity");
        expect(readGatewayAccessRevision()).toBe(revision);
      } else {
        replace();
        expect(readGatewayAccessRevision()).toBeGreaterThan(revision);
      }
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: rollback || sameId ? "original" : "replacement",
        lifecycleRevision: rollback ? "before" : "after",
      });
    });
  },
);

it.each(["agent", "chat"] as const)(
  "invalidates committed compaction access after the %s run is aborted and removed",
  async (kind) => {
    await withAccessFixture(async ({ scope, params, start }) => {
      const entry = {
        sessionId: "predecessor",
        lifecycleRevision: "current-lifecycle",
        activeWriterRunId: undefined,
        updatedAt: 1,
        visibility: "shared" as const,
      };
      await upsertSessionEntryCore(scope, entry);
      addSessionMember(scope, { identityId: "member", addedBy: "owner" });
      const runId = `compaction-${kind}`;
      const run = registerSubscriptionChatRun(params, {
        runId,
        ...scope,
        sessionId: entry.sessionId,
        ...(kind === "agent" ? { kind: "agent" as const } : {}),
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
        expect(listSessionMembers(scope)).toEqual([]);
      } finally {
        abort();
        run.cleanup();
        forgetActiveSessionForShutdown(entry.sessionId);
        forgetActiveSessionForShutdown("successor");
      }
    });
  },
);

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
    await first.taskUnsub();
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
