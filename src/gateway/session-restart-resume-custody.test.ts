import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { hasPrivateRequesterInput } from "../agents/subagents/registry/subagent-delivery-state.js";
import { createLifecycleControllerFixture } from "../agents/subagents/registry/subagent-registry-lifecycle-controller.test-support.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { saveSubagentRegistryChangesToSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import { settleRestartInterruptedSubagentRun } from "../agents/subagents/registry/subagent-registry-sweep-settle.js";
import { observeRootWork } from "../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import { writeSubagentRunValuesInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionQueuedInputPage } from "../config/sessions/session-pending-input-history.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { ensureSessionPendingInputsSchema } from "../state/openclaw-agent-pending-inputs-schema.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { QueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import {
  createOperatorRecoveryFixture,
  pairedOperator,
} from "./operator-run-recovery.test-support.js";
import { ADMIN_SCOPE, READ_SCOPE, WRITE_SCOPE } from "./operator-scopes.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { prepareRestartCompletionCustody } from "./session-restart-resume-custody.js";
import { prepareRestartStores } from "./session-restart-resume-discovery.js";

type WokenAs = { profileId?: string; scopes?: readonly string[] };

it.each([false, true])("recovers v2026.11.7 private queued input unless ended=%s", (ended) =>
  withOpenClawTestState(
    {
      scenario: "minimal",
      env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" },
    },
    async ({ stateDir }) => {
      setRuntimeConfigSnapshot({});
      const target = {
        agentId: "main",
        physicalAgentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        sessionKey: "agent:main:dashboard:queued-completion",
        sessionId: "queued-completion",
      };
      const entry = {
        sessionId: target.sessionId,
        lifecycleRevision: "queued-revision",
        updatedAt: 1,
      };
      replaceSessionEntrySync(target, entry);
      const runId = `announce:requester-settle:main:${target.sessionKey}:queued-child`;
      const raw = "Accepted private completion";
      // Literal writer shapes from v2026.11.7 (e31bbf056de3), not current fixture factories.
      // Its privateInput has no discriminator; its pending table has no source/end-cause columns.
      const storedChild = {
        runId: "queued-child",
        childSessionKey: "agent:main:subagent:queued-child",
        childAgentId: "main",
        childSessionIdentity: { sessionId: "queued-child" },
        requesterSessionKey: target.sessionKey,
        requesterAgentId: target.agentId,
        requesterStorePath: target.storePath,
        completionRequesterSessionId: entry.sessionId,
        completionRequesterLifecycleRevision: entry.lifecycleRevision,
        completionTarget: "parent",
        task: "Preserve the private completion",
        cleanup: "keep",
        createdAt: 1,
        expectsCompletionMessage: true,
        execution: { status: "terminal", startedAt: 1, endedAt: 2 },
        completion: { required: true },
        delivery: {
          status: "pending",
          requesterDelivery: { state: "waiting", runId, at: 2 },
        },
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 1,
          batchRunIds: ["queued-child"],
          privateInput: { runId, message: raw },
        },
      };
      runOpenClawStateWriteTransaction((database) =>
        writeSubagentRunValuesInDatabase(
          database,
          [
            {
              run_id: storedChild.runId,
              child_session_key: storedChild.childSessionKey,
              requester_session_key: target.sessionKey,
              controller_session_key: null,
              requester_store_path: target.storePath,
              controller_store_path: null,
              created_at: 1,
              payload_json: JSON.stringify({ parentCompletion: storedChild }),
            },
          ],
          [],
        ),
      );
      const messageJson = JSON.stringify({
        role: "user",
        content: raw,
        timestamp: 2,
        idempotencyKey: `${runId}:user`,
        provenance: {
          kind: "inter_session",
          sourceTool: "subagent_settle",
          sourceSessionKey: storedChild.childSessionKey,
        },
      });
      const database = openOpenClawAgentDatabase({ agentId: target.agentId });
      ensureSessionPendingInputsSchema(database.db);
      database.db
        .prepare(`INSERT INTO session_pending_inputs (
      input_id, session_key, session_id, idempotency_key, run_id, request_hash,
      message_json, lifecycle_generation, state, accepted_at, consumed_event_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL)`)
        .run(
          "queued-input",
          target.sessionKey,
          target.sessionId,
          `${runId}:user`,
          runId,
          "request:release-request-hash",
          messageJson,
          "release-generation",
          2,
        );
      closeOpenClawAgentDatabasesForTest(stateDir);
      closeOpenClawStateDatabaseForTest();
      clearSubagentRunsReadCacheForTest();
      try {
        expect(await restoreSubagentRunsFromDisk({ runs: subagentRuns })).toBe(1);
        const child = subagentRuns.get(storedChild.runId)!;
        expect(child.requesterSettleWake?.privateInput).toEqual({ runId, message: raw });
        expect(hasPrivateRequesterInput(child)).toBe(true);
        expect(subagentRuns.isCompletionAuthorityRetired(child)).toBe(true);
        const context = createContext();
        context.resolveGatewayContext = () => context;
        const restart = { context, signal: new AbortController().signal, log: { warn: vi.fn() } };
        const custody = await prepareRestartCompletionCustody(restart, {
          target,
          entries: [{ sessionKey: target.sessionKey, entry }],
        });
        const before = (await readSessionQueuedInputPage(target)).rows;
        expect(before).toHaveLength(1);
        const row = before[0]!;
        expect(row).toMatchObject({
          message_json: messageJson,
          request_hash: "request:release-request-hash",
          origin_source_json: null,
          end_cause: null,
        });
        expect(custody.ownsInput(row, target.agentId)).toBe(true);
        expect(
          custody.ownsInput(
            { ...row, run_id: `${runId}:other`, idempotency_key: `${runId}:other:user` },
            target.agentId,
          ),
        ).toBe(false);
        expect(custody.ownsInput(row, "other-agent")).toBe(false);
        const foreignSource = JSON.parse(row.message_json);
        foreignSource.provenance.sourceSessionKey = "agent:main:subagent:unrelated";
        expect(
          custody.ownsInput(
            { ...row, message_json: JSON.stringify(foreignSource) },
            target.agentId,
          ),
        ).toBe(false);
        await continueSessionQueuedInputs(context, target, {
          ...restart,
          assertCurrent: custody.assertCurrent,
          ownsInput: (queued) => custody.ownsInput(queued, target.agentId),
          ...(ended ? { endCause: "restart-unrecoverable" as const } : {}),
        });
        expect((await readSessionQueuedInputPage(target)).rows).toEqual(ended ? [] : before);
        expect(context.logGateway.warn).not.toHaveBeenCalled();
        subagentRuns.retireCompletionAuthority(child);
        expect(custody.ownsInput(row, target.agentId)).toBe(false);
        const replacement = { ...child, generation: (child.generation ?? 0) + 1 };
        subagentRuns.set(child.runId, replacement);
        expect(subagentRuns.isCompletionAuthorityRetired(replacement)).toBe(false);
        expect(custody.ownsInput(row, target.agentId)).toBe(false);
        replaceSessionEntrySync(target, { sessionId: "replacement", updatedAt: 2 });
        expect((await readSessionQueuedInputPage(target)).rows).toEqual([]);
      } finally {
        const child = subagentRuns.get(storedChild.runId);
        if (child) {
          subagentRuns.retireCompletionAuthority(child);
        }
        subagentRuns.delete(storedChild.runId);
        clearSubagentRunsReadCacheForTest();
      }
    },
  ),
);

/** Restores one owed child after a restart and returns the authority its woken parent turn had. */
async function deliverOwedNoticeAfterRestart(params: {
  state: "completed" | "interrupted";
  createdActor?: InternalSessionEntry["createdActor"];
  requesterOperatorSource?: QueuedOperatorRecoverySource;
  context: GatewayRequestContext;
  sessionKey?: string;
}): Promise<WokenAs | undefined> {
  const { state, sessionKey = "agent:main:dashboard:settled-requester" } = params;
  const target = {
    agentId: "main",
    physicalAgentId: "main",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  const entry = {
    sessionId: "settled-requester",
    lifecycleRevision: "original-revision",
    updatedAt: 1,
    ...(params.createdActor ? { createdActor: params.createdActor } : {}),
  };
  replaceSessionEntrySync({ ...target, sessionKey }, entry);
  const child = createSubagentRunRecord({
    runId: "owed-completion",
    childSessionKey: "agent:main:subagent:finished-child",
    requesterSessionKey: sessionKey,
    requesterAgentId: "main",
    requesterStorePath: target.storePath,
    completionRequesterSessionId: entry.sessionId,
    completionRequesterLifecycleRevision: entry.lifecycleRevision,
    expectsCompletionMessage: true,
    spawnMode: "session",
    completionTarget: "parent",
    ...(params.requesterOperatorSource
      ? { requesterOperatorSource: params.requesterOperatorSource }
      : {}),
    ...(state === "completed"
      ? { endedAt: 1, delivery: { status: "pending" as const } }
      : {
          createdAt: Math.floor(performance.timeOrigin) - 10_000,
          startedAt: Math.floor(performance.timeOrigin) - 9_000,
        }),
  });
  subagentRuns.set(child.runId, child);
  subagentRuns.retireCompletionAuthority(child);
  try {
    const restart = {
      context: params.context,
      signal: new AbortController().signal,
      log: { warn: vi.fn() },
    };
    restart.context.resolveGatewayContext ??= () => restart.context;
    const recover = async () => {
      const stores = await prepareRestartStores(restart, [target]);
      expect(stores?.[0]?.entries.map((row) => row.sessionKey)).toContain(sessionKey);
      await prepareRestartCompletionCustody(restart, stores![0]!);
      expect(restart.log.warn.mock.calls).toEqual([]);
    };
    if (state === "completed") {
      await recover();
      expect(subagentRuns.isCompletionAuthorityRetired(child)).toBe(false);
      return undefined;
    }
    const received: string[] = [];
    let wokenAs: WokenAs | undefined;
    const controller = createLifecycleControllerFixture(
      {
        entry: child,
        runs: subagentRuns,
        realWorker: true,
        runSubagentAnnounceFlow: async (notice) => {
          const client = getPluginRuntimeGatewayRequestScope()?.client;
          wokenAs = {
            profileId: client?.internal?.operatorRunAuthority?.profileId,
            scopes: client?.connect.scopes,
          };
          if (notice.outcome?.status !== "error") {
            throw new Error("Missing interrupted outcome");
          }
          received.push(notice.outcome.error!);
          return "delivered";
        },
      },
      {
        callGateway: vi.fn(),
        cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
        ownersByEntry: new Map(),
      },
    );
    saveSubagentRegistryChangesToSqlite(subagentRuns, [child.runId]);
    const settle = async () => {
      const drain = observeRootWork();
      try {
        return await settleRestartInterruptedSubagentRun({
          runId: child.runId,
          entry: subagentRuns.get(child.runId)!,
          complete: controller.completeSubagentRun,
          now: Date.now(),
        });
      } finally {
        await drain();
      }
    };
    expect(await settle()).toBe(false);
    await recover();
    await settle();
    expect(received).toEqual([
      "The Gateway stopped before this subagent finished. Its run did not survive the restart; inspect its saved work before retrying.",
    ]);
    expect(subagentRuns.get(child.runId)?.delivery?.status).toBe("delivered");
    return wokenAs;
  } finally {
    subagentRuns.delete(child.runId);
  }
}

it.each([
  { state: "completed", requester: "profile" },
  { state: "interrupted", requester: "profile" },
  { state: "interrupted", requester: "unattributed" },
] as const)(
  "delivers a restored $state child's owed notice after its legacy $requester requester settled",
  ({ state, requester }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const person = ensureGatewayOwnerProfile("Restart custody owner");
      const wokenAs = await deliverOwedNoticeAfterRestart({
        state,
        context: createContext(),
        ...(requester === "profile"
          ? { createdActor: { type: "human", source: "profile", id: person.id } }
          : {}),
      });
      if (state === "interrupted") {
        // A row without a saved requester uses the session principal, else the System write
        // baseline, never admin.
        expect(wokenAs).toMatchObject(
          requester === "profile" ? { profileId: person.id } : { scopes: [WRITE_SCOPE] },
        );
      }
    }),
);

it.each([
  { requester: "owner", scopes: [ADMIN_SCOPE], admin: true },
  { requester: "writer", scopes: [READ_SCOPE, WRITE_SCOPE], admin: false },
])(
  "wakes the parent with the saved $requester requester's scopes after a restart",
  ({ scopes, admin }) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      setRuntimeConfigSnapshot({});
      const profile = ensureProfileForEmail("restart-requester@example.test");
      const spawned = await createOperatorRecoveryFixture({
        stateDir,
        profileId: profile.id,
        context: createContext(),
        config: {},
        scopes,
        device: pairedOperator(),
        // The requester's chat; a second chat for the same person would archive it as stale.
        sessionKey: "agent:main:dashboard:settled-requester",
        sessionId: "settled-requester",
      });
      const requesterOperatorSource = captureQueuedOperatorRecoverySource(spawned.sourceAuthority);
      expect(requesterOperatorSource?.kind).toBe("gateway");
      const wokenAs = await deliverOwedNoticeAfterRestart({
        state: "interrupted",
        createdActor: { type: "human", source: "profile", id: profile.id },
        requesterOperatorSource,
        context: spawned.context,
      });
      expect(wokenAs?.profileId).toBe(profile.id);
      if (admin) {
        expect(wokenAs?.scopes).toContain(ADMIN_SCOPE);
      } else {
        expect(wokenAs?.scopes).toContain(WRITE_SCOPE);
        expect(wokenAs?.scopes).not.toContain(ADMIN_SCOPE);
      }
    }),
);

it("recovers a sibling child when another child's saved requester is refused", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      physicalAgentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    const sessionKey = "agent:main:dashboard:two-children";
    const entry = { sessionId: "two-children", lifecycleRevision: "rev", updatedAt: 1 };
    replaceSessionEntrySync({ ...target, sessionKey }, entry);
    const [refused, legacy] = (["refused", "legacy"] as const).map((name) =>
      createSubagentRunRecord({
        runId: `${name}-child`,
        childSessionKey: `agent:main:subagent:${name}`,
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterStorePath: target.storePath,
        completionRequesterSessionId: entry.sessionId,
        completionRequesterLifecycleRevision: entry.lifecycleRevision,
        expectsCompletionMessage: true,
        spawnMode: "session",
        completionTarget: "parent",
        endedAt: 1,
        delivery: { status: "pending" },
        // A source that current policy refuses, for example a revoked device.
        ...(name === "refused" ? { requesterOperatorSource: { kind: "unavailable" } } : {}),
      }),
    );
    for (const child of [refused!, legacy!]) {
      subagentRuns.set(child.runId, child);
      subagentRuns.retireCompletionAuthority(child);
    }
    try {
      const context = createContext();
      context.resolveGatewayContext = () => context;
      const restart = { context, signal: new AbortController().signal, log: { warn: vi.fn() } };
      const stores = await prepareRestartStores(restart, [target]);
      await prepareRestartCompletionCustody(restart, stores![0]!);
      expect(subagentRuns.isCompletionAuthorityRetired(refused!)).toBe(true);
      expect(subagentRuns.isCompletionAuthorityRetired(legacy!)).toBe(false);
      expect(restart.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Restart completion recovery failed for refused-child"),
      );
    } finally {
      subagentRuns.delete(refused!.runId);
      subagentRuns.delete(legacy!.runId);
    }
  }));

it.for(["archived", "replaced", "reset"] as const)(
  "does not recover completion custody from a stale %s requester snapshot",
  (change) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const person = ensureGatewayOwnerProfile("Restart custody owner");
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:retired-requester",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const entry: InternalSessionEntry = {
        sessionId: "original-requester",
        lifecycleRevision: "original-revision",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: person.id },
      };
      replaceSessionEntrySync(target, {
        ...entry,
        ...(change === "archived"
          ? { archivedAt: 2 }
          : change === "replaced"
            ? { sessionId: "replacement-requester" }
            : { lifecycleRevision: "reset-revision" }),
      });
      const child = createSubagentRunRecord({
        runId: "retained-child-completion",
        childSessionKey: "agent:main:dashboard:retained-child",
        requesterSessionKey: target.sessionKey,
        requesterAgentId: target.agentId,
        requesterStorePath: target.storePath,
        completionRequesterSessionId: entry.sessionId,
        completionRequesterLifecycleRevision: entry.lifecycleRevision,
        expectsCompletionMessage: true,
        spawnMode: "session",
        completionTarget: "parent",
        endedAt: 1,
        delivery: { status: "pending" },
      });
      subagentRuns.set(child.runId, child);
      subagentRuns.retireCompletionAuthority(child);
      try {
        const warn = vi.fn();
        await prepareRestartCompletionCustody(
          {
            context: createContext(),
            signal: new AbortController().signal,
            log: { warn },
          },
          {
            target: { ...target, physicalAgentId: target.agentId },
            entries: [{ sessionKey: target.sessionKey, entry }],
          },
        );
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("Restart completion recovery failed"),
        );
        expect(subagentRuns.isCompletionAuthorityRetired(child)).toBe(true);
      } finally {
        subagentRuns.delete(child.runId);
      }
    }),
);

// A completion wake starts parent work, so only the scope the requester's work belongs to may
// recover it: its shutdown marker's scope, else the scope its latest run started under.
it.for([
  { stored: "token-a", marker: undefined, startup: "token-a", recovers: true },
  { stored: "token-a", marker: undefined, startup: "token-b", recovers: false },
  { stored: undefined, marker: undefined, startup: "token-b", recovers: false },
  { stored: "token-b", marker: "token-a", startup: "token-b", recovers: false },
  { stored: undefined, marker: undefined, startup: undefined, recovers: true },
] as const)(
  "recovers completion custody of work from scope $marker/$stored only at startup scope $startup",
  ({ stored, marker, startup, recovers }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const person = ensureGatewayOwnerProfile("Restart custody owner");
      const target = {
        agentId: "main",
        physicalAgentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const sessionKey = "agent:main:dashboard:scoped-requester";
      const entry: InternalSessionEntry = {
        sessionId: "scoped-requester",
        lifecycleRevision: "original-revision",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: person.id },
      };
      replaceSessionEntrySync({ ...target, sessionKey }, entry);
      // Private restart evidence belongs to an existing incarnation.
      replaceSessionEntrySync(
        { ...target, sessionKey },
        {
          ...entry,
          ...(stored ? { lifecycleRestartScope: stored } : {}),
          ...(marker ? { resumeAfterRestart: { scope: marker } } : {}),
        },
      );
      const child = createSubagentRunRecord({
        runId: "scoped-completion",
        childSessionKey: "agent:main:subagent:scoped-child",
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterStorePath: target.storePath,
        completionRequesterSessionId: entry.sessionId,
        completionRequesterLifecycleRevision: entry.lifecycleRevision,
        expectsCompletionMessage: true,
        spawnMode: "session",
        completionTarget: "parent",
        endedAt: 1,
        delivery: { status: "pending" },
      });
      subagentRuns.set(child.runId, child);
      subagentRuns.retireCompletionAuthority(child);
      vi.stubEnv("OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE", startup);
      try {
        const params = {
          context: createContext(),
          signal: new AbortController().signal,
          log: { warn: vi.fn() },
        };
        params.context.resolveGatewayContext = () => params.context;
        const stores = await prepareRestartStores(params, [target]);
        expect(stores?.[0]?.entries.map((row) => row.entry.lifecycleRestartScope)).toEqual([
          stored,
        ]);
        await prepareRestartCompletionCustody(params, stores![0]!);
        expect(params.log.warn).not.toHaveBeenCalled();
        expect(subagentRuns.isCompletionAuthorityRetired(child)).toBe(!recovers);
      } finally {
        subagentRuns.delete(child.runId);
      }
    }),
);
