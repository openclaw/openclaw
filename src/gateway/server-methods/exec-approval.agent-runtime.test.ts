import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi, type TestContext } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { resolveApprovalSessionAudienceWithFallback } from "../approval-session-audience.js";
import { createPreparedTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { sanitizeSystemRunParamsForForwarding } from "../node-invoke-system-run-approval.js";
import type { OperatorApprovalRecord } from "../operator-approval-store.types.js";
import { createChatRunState } from "../server-chat-state.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "../worker-environments/placement-test-fixtures.js";
import { bindWorkerTurnOwner } from "../worker-environments/placement-turn-claim-events.js";
import * as workerRunOwner from "../worker-environments/worker-turn-run-owner.js";
import { waitForApprovalRequested } from "./approval-request.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

vi.mock("../../infra/command-analysis/explain.js", () => ({
  resolveCommandAnalysisSummaryForDisplay: vi.fn(async () => null),
}));

function identity(enabled: boolean): AgentRuntimeIdentity {
  return {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:session-1",
    operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
    delegatedAuthority: {
      kind: "local",
      operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
      lifecycleGeneration: "generation-1",
      claimId: "claim-1",
    },
    turnSourceChannel: "telegram",
    turnSourceTo: "chat-1",
    turnSourceAccountId: "default",
    turnSourceThreadId: "thread-1",
    ...(enabled
      ? {
          executionIdentity: {
            tokenVersion: 1,
            createdAt: 1,
            runId: "run-1",
            contextId: "context-1",
            executionId: "execution-1",
          },
        }
      : {}),
  };
}

function requestOptions(
  runtimeIdentity: AgentRuntimeIdentity,
  validateAuthority: () => boolean = () => true,
): GatewayRequestHandlerOptions {
  const request = {
    command: "echo ok",
    cwd: "/tmp",
    agentId: "forged-agent",
    sessionKey: "forged-session",
    sessionId: "forged-session-id",
    runId: "forged-run",
    turnSourceChannel: "forged-channel",
    turnSourceTo: "forged-target",
    turnSourceAccountId: "forged-account",
    turnSourceThreadId: "forged-thread",
    timeoutMs: 2_000,
    twoPhase: true,
  };
  return {
    req: { method: "exec.approval.request", params: request, id: "req-1" },
    params: request,
    client: {
      connId: "conn-agent-runtime",
      connect: { client: { id: "test-client", displayName: "Test Client" } },
      internal: { agentRuntimeIdentity: runtimeIdentity },
    },
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      getRuntimeConfig: () => ({}),
      hasExecApprovalClients: () => true,
      chatRunState: createChatRunState(),
      validateAgentRuntimeApprovalAuthority: validateAuthority,
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    },
  } as unknown as GatewayRequestHandlerOptions;
}

type ApprovalFixture = Awaited<
  ReturnType<typeof createPreparedTestApprovalManager<ExecApprovalRequestPayload>>
>;

function createApproval(test: TestContext, validate = () => true) {
  return createPreparedTestApprovalManager(test, {
    validateAgentRuntimeDelegatedAuthority: validate,
  });
}

function requestApproval(fixture: ApprovalFixture, opts: GatewayRequestHandlerOptions) {
  const handler = expectDefined(
    createExecApprovalHandlers(fixture.manager)["exec.approval.request"],
    "exec approval request handler",
  );
  return waitForApprovalRequested(opts.context, "exec.approval.requested", () =>
    fixture.track(Promise.resolve(handler(opts))),
  );
}

async function pendingRecord(fixture: ApprovalFixture) {
  const records = await fixture.manager.listPendingRecords();
  expect(records).toHaveLength(1);
  return expectDefined(records[0], "registered approval");
}

describe("exec approval signed agent runtime", () => {
  it("binds the accepted expiry to the worker captured before registration yields", async (testContext) => {
    let active = true;
    const fixture = await createPreparedTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: () => active,
    });
    const { manager } = fixture;
    const runtimeIdentity = identity(false);
    const turnClaim = {
      sessionId: "worker-session",
      claimId: "worker-claim",
      runId: "run-1",
      placementGeneration: 1,
      owner: { kind: "worker" as const, environmentId: "worker-env", ownerEpoch: 1 },
    };
    runtimeIdentity.delegatedAuthority = {
      ...runtimeIdentity.delegatedAuthority,
      kind: "worker",
      turnClaim,
    };
    const close = vi.fn();
    const beginApprovalWait = vi.fn<workerRunOwner.WorkerTurnLiveEventOwner["beginApprovalWait"]>(
      () => ({ close, updateDeadline: vi.fn() }),
    );
    const successorWait = vi.fn();
    const capture = vi.spyOn(workerRunOwner, "captureWorkerTurnLiveEventOwner").mockReturnValue({
      beginApprovalWait,
      record: vi.fn(),
      isCancelled: () => false,
      isCancelledFinishing: () => false,
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const register = manager.register.bind(manager);
    const registration = vi
      .spyOn(manager, "register")
      .mockImplementation(async (record, timeoutMs) => {
        entered.resolve();
        await release.promise;
        return await register(record, timeoutMs);
      });
    try {
      await fixture.run(async () => {
        const opts = requestOptions(runtimeIdentity, () => active);
        const requested = waitForApprovalRequested(opts.context, "exec.approval.requested", () =>
          fixture.track(
            Promise.resolve(createExecApprovalHandlers(manager)["exec.approval.request"]!(opts)),
          ),
        );
        await entered.promise;
        expect(capture).toHaveBeenCalledExactlyOnceWith({
          sessionId: turnClaim.sessionId,
          turnClaim,
        });
        expect(beginApprovalWait).not.toHaveBeenCalled();
        capture.mockReturnValue({
          beginApprovalWait: successorWait,
          record: vi.fn(),
          isCancelled: () => false,
          isCancelledFinishing: () => false,
        });
        release.resolve();
        const { pending } = await requested;
        const record = manager.listLocalPendingRecords()[0]!;
        expect(beginApprovalWait).toHaveBeenCalledExactlyOnceWith(
          record.expiresAtMs,
          expect.any(Function),
        );
        expect(successorWait).not.toHaveBeenCalled();
        const isPending = beginApprovalWait.mock.calls[0]![1];
        expect(isPending()).toBe(true);
        expect(manager.isPending({ ...record })).toBe(false);
        active = false;
        expect(isPending()).toBe(false);
        active = true;
        await manager.resolve(record.id, "allow-once", "operator");
        await pending;
        expect(isPending()).toBe(false);
        expect(close).toHaveBeenCalledOnce();
      });
    } finally {
      release.resolve();
      registration.mockRestore();
      capture.mockRestore();
    }
  });

  it.for([false, true])(
    "checks live worker claims without host SQL in a registered approval (revoked: %s)",
    async (revoked, testContext) => {
      const source = {
        sessionId: "worker-approval-session",
        agentId: "main",
        sessionKey: "agent:main:worker-approval-session",
      };
      let validate: ReturnType<typeof createAgentRuntimeApprovalAuthorityValidator> | undefined;
      const guardCalls: number[][] = [];
      const check = (runtimeIdentity: AgentRuntimeIdentity) => {
        if (!validate) {
          return false;
        }
        const sql = observeHostDataSql();
        try {
          return validate(runtimeIdentity);
        } finally {
          guardCalls.push(sql.calls.map((call) => call.mock.calls.length));
          sql.restore();
        }
      };
      const fixture = await createPreparedTestApprovalManager(testContext, {
        validateAgentRuntimeDelegatedAuthority: (authority) =>
          check({
            kind: "agentRuntime",
            agentId: source.agentId,
            sessionKey: source.sessionKey,
            operationalRunInstance: authority.operationalRunInstance,
            delegatedAuthority: authority,
          }),
      });
      await fixture.run(async () => {
        const database = openOpenClawStateDatabase(fixture.databaseOptions);
        const placements = createWorkerSessionPlacementStore({ database });
        await advancePlacementFixtureToActive(placements, database, source, {
          environmentId: "worker-approval-environment",
          ownerEpoch: 3,
          remoteWorkspaceDir: "/workspace/approval",
          seedEnvironment: "before-dispatch",
        });
        const claim = await placements.claimTurn({
          ...source,
          claimId: "worker-approval-claim",
          runId: "worker-approval-run",
          owner: { kind: "worker", environmentId: "worker-approval-environment", ownerEpoch: 3 },
        });
        const instance = createOperationalRunInstanceRef(claim.runId);
        const delegated = claimAgentRunDelegatedAuthority(instance);
        try {
          const { capability } = await bindWorkerTurnOwner(
            placements,
            claim,
            undefined,
            instance,
            {
              ...source,
              storePath: path.join(fixture.databaseOptions.env.OPENCLAW_STATE_DIR, "sessions.json"),
            },
            () => {},
          );
          validate = createAgentRuntimeApprovalAuthorityValidator(placements);
          const runtimeIdentity = await capability.run((owner): AgentRuntimeIdentity => ({
            kind: "agentRuntime",
            agentId: owner.agentId,
            sessionKey: owner.sessionKey,
            operationalRunInstance: owner.operationalRunInstance,
            delegatedAuthority: {
              kind: "worker",
              ...owner.delegatedAuthority,
              turnClaim: owner.turnClaim,
            },
          }));
          const calibration = observeHostDataSql();
          try {
            const statement = database.db.prepare("SELECT 1");
            database.db.exec("SELECT 1");
            statement.get();
            statement.all();
            statement.run();
            expect([...statement.iterate()]).toHaveLength(1);
            for (const call of calibration.calls) {
              expect(call).toHaveBeenCalled();
            }
          } finally {
            calibration.restore();
          }
          const options = requestOptions(runtimeIdentity, () => check(runtimeIdentity));
          Object.assign(options.params, { timeoutMs: 60_000 });

          const { pending } = await requestApproval(fixture, options);
          const record = await pendingRecord(fixture);
          if (revoked) {
            await placements.releaseTurn(claim);
          }
          await fixture.manager.resolve(record.id, "allow-once");
          await pending;
          const snapshot = await fixture.manager.getSnapshot(record.id);
          expect([snapshot?.status, snapshot?.decision]).toEqual(
            revoked ? ["cancelled", undefined] : ["allowed", "allow-once"],
          );
          expect(guardCalls.length).toBeGreaterThan(1);
          for (const calls of guardCalls) {
            expect(calls).toEqual([0, 0, 0, 0, 0, 0]);
          }
        } finally {
          if (placements.validateTurnClaim(claim)) {
            await placements.releaseTurn(claim);
          }
          releaseAgentRunDelegatedAuthority(delegated);
        }
      });
    },
  );

  it("prepares retained approval lineage without synchronously loading full registry payloads", async (testContext) => {
    await withOpenClawTestState(
      {
        scenario: "minimal",
        env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" },
      },
      async () => {
        setRuntimeConfigSnapshot({});
        clearSubagentRunsReadCacheForTest();
        const child = "agent:main:subagent:incognito-approval-child";
        const parent = "agent:main:dashboard:incognito-approval-parent";
        const root = "agent:main:dashboard:incognito-approval-root";
        const run = createSubagentRunRecord({
          runId: "approval-retained-child",
          childSessionKey: child,
          requesterSessionKey: parent,
          completion: { required: false },
          delivery: { status: "not_required" },
        });
        saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: parent },
          {
            sessionId: "approval-incognito-parent",
            updatedAt: 1,
            parentSessionKey: root,
            incognito: true,
          },
        );
        const hostRegistryReads = trackSqliteStatementExecutions(
          requireNativeSqliteDatabase(openOpenClawStateDatabase().db),
          ["registryPayload"],
          (sql) =>
            /\bfrom\s+"?subagent_runs\b/iu.test(sql) && /\bpayload_json\b/iu.test(sql)
              ? "registryPayload"
              : null,
        );
        const registered = createDeferredCore<OperatorApprovalRecord>();
        const fixture = await createPreparedTestApprovalManager(testContext, {
          resolveAudienceSessionKeys: resolveApprovalSessionAudienceWithFallback,
          validateAgentRuntimeDelegatedAuthority: () => true,
          onLifecycle: (event) => {
            if (event.phase === "pending") {
              registered.resolve(event.record);
            }
          },
        });
        const { manager } = fixture;
        await fixture.run(async () => {
          const opts = requestOptions({ ...identity(false), sessionKey: child });
          const approvalId = "approval-prepared-lineage";
          Object.assign(opts.params, {
            id: approvalId,
            timeoutMs: 60_000,
            requireDeliveryRoute: false,
            suppressDelivery: true,
          });
          const pending = fixture.track(
            Promise.resolve(createExecApprovalHandlers(manager)["exec.approval.request"]!(opts)),
          );
          try {
            const approval = await Promise.race([
              registered.promise,
              pending.then(() => {
                throw new Error("Approval request ended before registration");
              }),
            ]);
            expect(approval.audienceSessionKeys).toEqual([child, parent, root]);
            expect(hostRegistryReads.counts.registryPayload).toBe(0);
          } finally {
            hostRegistryReads.restore();
            await manager.resolve(approvalId, "deny");
            await pending;
            clearSubagentRunsReadCacheForTest();
          }
        });
      },
    );
  });

  it("rejects closed authority before creating an exec approval", async (testContext) => {
    const fixture = await createApproval(testContext, () => false);
    const { manager } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions(identity(false), () => false);

      await createExecApprovalHandlers(manager)["exec.approval.request"]!(opts);

      expect(await manager.listPendingRecords()).toHaveLength(0);
      expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
        message: expect.stringContaining("no longer active"),
      });
    });
  });

  it("records an omitted node session before approved replay", async (testContext) => {
    const fixture = await createApproval(testContext);
    const { manager } = fixture;
    await fixture.run(async () => {
      const runtimeIdentity = identity(false);
      const options = requestOptions(runtimeIdentity);
      const command = ["/usr/bin/echo", "ok"];
      const commandText = "/usr/bin/echo ok";
      const target = {
        cwd: "/tmp",
        agentId: runtimeIdentity.agentId,
        sessionKey: runtimeIdentity.sessionKey,
      };
      Object.assign(options.params, {
        host: "node",
        nodeId: "node-1",
        command: commandText,
        systemRunPlan: {
          argv: command,
          commandText,
          cwd: "/tmp",
          agentId: "main",
          sessionKey: null,
          policySnapshot: {
            security: "allowlist",
            ask: "always",
            askFallback: "deny",
            autoAllowSkills: false,
            allowlistRules: [],
          },
        },
      });
      const { pending } = await requestApproval(fixture, options);
      const record = await pendingRecord(fixture);
      await manager.resolve(record.id, "allow-once");
      await pending;

      const result = await sanitizeSystemRunParamsForForwarding({
        nodeId: "node-1",
        rawParams: {
          runId: record.id,
          approved: true,
          command,
          rawCommand: commandText,
          ...target,
        },
        client: options.client,
        execApprovalManager: manager,
      });
      expect(result).toMatchObject({
        ok: true,
        params: {
          ...target,
          systemRunPlan: {
            argv: command,
            commandText,
            ...target,
          },
        },
      });
    });
  });

  it("sanitizes display-only cwd and resolvedPath in the stored request", async (testContext) => {
    const fixture = await createApproval(testContext);
    const { manager } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions(identity(false));
      // Reviewer paths escape invisible characters; policy values remain closed enums.
      Object.assign(opts.params, {
        cwd: "/tmp/safe‮evil",
        resolvedPath: "/usr/bin/echo​x",
        security: "full‮looks-deny",
        ask: "always​ish",
      });
      const { pending } = await requestApproval(fixture, opts);
      const record = await pendingRecord(fixture);
      expect(record.request).toMatchObject({
        cwd: "/tmp/safe\\u{202E}evil",
        resolvedPath: "/usr/bin/echo\\u{200B}x",
        security: null,
        ask: null,
      });
      await manager.resolve(record.id, "deny");
      await pending;
    });
  });

  it("cancels an exec approval when authority closes after the handshake", async (testContext) => {
    let active = true;
    const fixture = await createApproval(testContext, () => active);
    const { manager } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions(identity(false), () => active);
      const { pending } = await requestApproval(fixture, opts);
      const record = await pendingRecord(fixture);
      active = false;

      await expect(manager.awaitDecision(record.id)).resolves.toBeNull();
      await pending;
      expect(await manager.getSnapshot(record.id)).toMatchObject({ status: "cancelled" });
    });
  });

  it.for([
    ["enabled", true],
    ["disabled", false],
  ] as const)(
    "uses signed runtime provenance with collection %s",
    async ([_label, enabled], testContext) => {
      const fixture = await createApproval(testContext);
      const { manager, databaseOptions } = fixture;
      await fixture.run(async () => {
        const opts = requestOptions(identity(enabled));

        const { pending } = await requestApproval(fixture, opts);
        expect(opts.context.broadcast).toHaveBeenCalled();
        const approvalId = String(
          (vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as { id?: unknown } | undefined)
            ?.id,
        );
        expect((await manager.getSnapshot(approvalId))?.request).toMatchObject({
          agentId: "main",
          sessionKey: "agent:main:session-1",
          sessionId: null,
          runId: "run-1",
          turnSourceChannel: "telegram",
          turnSourceTo: "chat-1",
          turnSourceAccountId: "default",
          turnSourceThreadId: "thread-1",
        });
        const db = openOpenClawStateDatabase(databaseOptions).db;
        const table = "operator_approval_execution_identities";
        if (enabled) {
          expect(
            db
              .prepare(
                `SELECT approval_id, source_context_id, source_execution_id FROM ${table} WHERE approval_id = ?`,
              )
              .get(approvalId),
          ).toEqual({
            approval_id: approvalId,
            source_context_id: "context-1",
            source_execution_id: "execution-1",
          });
        } else {
          expect(
            db
              .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
              .get(table),
          ).toBeUndefined();
        }
        await manager.resolve(approvalId, "deny");
        await pending;
      });
    },
  );
});
