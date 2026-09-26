import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import * as subagentStore from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { resolveApprovalSessionAudienceWithFallback } from "../approval-session-audience.js";
import { createPreparedTestApprovalManager } from "../exec-approval-manager.test-support.js";
import type { OperatorApprovalRecord } from "../operator-approval-store.types.js";
import { createChatRunState } from "../server-chat-state.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../worker-environments/placement-test-fixtures.js";
import { bindWorkerTurnOwner } from "../worker-environments/placement-turn-claim-events.js";
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

describe("exec approval signed agent runtime", () => {
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
        seedAttachedPlacementEnvironment(database, {
          environmentId: "worker-approval-environment",
          sessionId: source.sessionId,
          ownerEpoch: 3,
        });
        let placement = placements.startDispatch(source);
        for (const [to, patch] of [
          ["provisioning", { environmentId: "worker-approval-environment" }],
          ["syncing", { workerBundleHash: "a".repeat(64) }],
          [
            "starting",
            {
              workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
              remoteWorkspaceDir: "/workspace/approval",
            },
          ],
          ["active", { activeOwnerEpoch: 3 }],
        ] as const) {
          placement = placements.transition({
            sessionId: source.sessionId,
            from: placement.state,
            to,
            expectedGeneration: placement.generation,
            patch,
          });
        }
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
          const handler = createExecApprovalHandlers(fixture.manager)["exec.approval.request"];
          if (!handler) {
            throw new Error("exec approval request handler is missing");
          }
          const { pending } = await waitForApprovalRequested(
            options.context,
            "exec.approval.requested",
            () => fixture.track(Promise.resolve(handler(options))),
          );
          const records = await fixture.manager.listPendingRecords();
          expect(records).toHaveLength(1);
          const record = records[0];
          if (!record) {
            throw new Error("registered worker approval is missing");
          }
          if (revoked) {
            await placements.releaseTurn(claim);
          }
          await fixture.manager.resolve(record.id, "allow-once");
          await pending;
          const snapshot = await fixture.manager.getSnapshot(record.id);
          expect(snapshot?.status).toBe(revoked ? "cancelled" : "allowed");
          expect(snapshot?.decision).toBe(revoked ? undefined : "allow-once");
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
        subagentStore.saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
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
          openOpenClawStateDatabase().db,
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
          const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
          const opts = requestOptions({ ...identity(false), sessionKey: child });
          const approvalId = "approval-prepared-lineage";
          Object.assign(opts.params, {
            id: approvalId,
            timeoutMs: 60_000,
            requireDeliveryRoute: false,
            suppressDelivery: true,
          });
          const pending = fixture.track(Promise.resolve(handler(opts)));
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
    const fixture = await createPreparedTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: () => false,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
      const opts = requestOptions(identity(false), () => false);

      await handler(opts);

      expect(await manager.listPendingRecords()).toHaveLength(0);
      expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
        message: expect.stringContaining("no longer active"),
      });
    });
  });

  it("sanitizes display-only cwd and resolvedPath in the stored request", async (testContext) => {
    const fixture = await createPreparedTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
      const opts = requestOptions(identity(false));
      // Bidi override in cwd/resolvedPath can spoof what path reviewers see.
      (opts.params as Record<string, unknown>).cwd = "/tmp/safe‮evil";
      (opts.params as Record<string, unknown>).resolvedPath = "/usr/bin/echo​x";
      // Free-form policy strings must not reach reviewer meta rows: security/ask
      // are closed enums (arbitrary values null out), host is escape-hardened.
      (opts.params as Record<string, unknown>).security = "full‮looks-deny";
      (opts.params as Record<string, unknown>).ask = "always​ish";
      const { pending } = await waitForApprovalRequested(
        opts.context,
        "exec.approval.requested",
        () => fixture.track(Promise.resolve(handler(opts))),
      );
      expect(await manager.listPendingRecords()).toHaveLength(1);
      const record = (await manager.listPendingRecords())[0]!;
      expect(record.request.cwd).toBe("/tmp/safe\\u{202E}evil");
      expect(record.request.resolvedPath).toBe("/usr/bin/echo\\u{200B}x");
      expect(record.request.security).toBeNull();
      expect(record.request.ask).toBeNull();
      await manager.resolve(record.id, "deny");
      await pending;
    });
  });

  it("cancels an exec approval when authority closes after the handshake", async (testContext) => {
    let active = true;
    const fixture = await createPreparedTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: () => active,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
      const opts = requestOptions(identity(false), () => active);
      const { pending } = await waitForApprovalRequested(
        opts.context,
        "exec.approval.requested",
        () => fixture.track(Promise.resolve(handler(opts))),
      );
      expect(await manager.listPendingRecords()).toHaveLength(1);
      const record = (await manager.listPendingRecords())[0]!;
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
      const fixture = await createPreparedTestApprovalManager(testContext, {
        approvalKind: "exec",
        validateAgentRuntimeDelegatedAuthority: () => true,
      });
      const { manager, databaseOptions: options } = fixture;
      await fixture.run(async () => {
        const handler = createExecApprovalHandlers(manager)["exec.approval.request"];
        if (!handler) {
          throw new Error("exec approval request handler is unavailable");
        }
        const opts = requestOptions(identity(enabled));

        const { pending } = await waitForApprovalRequested(
          opts.context,
          "exec.approval.requested",
          () => fixture.track(Promise.resolve(handler(opts))),
        );
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
        const db = openOpenClawStateDatabase(options).db;
        if (enabled) {
          expect(
            db
              .prepare(
                "SELECT approval_id, source_context_id, source_execution_id FROM operator_approval_execution_identities WHERE approval_id = ?",
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
              .prepare(
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approval_execution_identities'",
              )
              .get(),
          ).toBeUndefined();
        }
        await manager.resolve(approvalId, "deny");
        await pending;
      });
    },
  );
});
