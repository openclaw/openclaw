import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import * as gatewayRequests from "../../agents/tools/in-process-gateway.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import * as execApprovals from "../../infra/exec-approvals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createWorkerExecApprovalTransport } from "../../worker/worker-exec-approval.js";
import { createWorkerPlacementTools } from "../../worker/worker-placement-tools.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { resolveApprovalSessionAudienceWithFallback } from "../approval-session-audience.js";
import { createPreparedTestApprovalManager } from "../exec-approval-manager.test-support.js";
import type { OperatorApprovalRecord } from "../operator-approval-store.types.js";
import { createChatRunState } from "../server-chat-state.js";
import type { WorkerConnectionIdentity } from "../worker-environments/connection-identity.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../worker-environments/placement-test-fixtures.js";
import {
  bindWorkerTurnCapabilities,
  bindWorkerTurnOwner,
} from "../worker-environments/placement-turn-claim-events.js";
import { createWorkerSessionPlacementGate } from "../worker-environments/placement-worker-gate.js";
import { createWorkerExecApprovalRpc } from "../worker-environments/worker-exec-approval.js";
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
        let placement = await placements.startDispatch(source);
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
          placement = await placements.transition({
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
          if (!revoked) {
            // Exercise the worker adapter against the canonical registration and wait owners.
            const workerIdentity: WorkerConnectionIdentity = {
              environmentId: "worker-approval-environment",
              credentialHash: "worker-hash",
              bundleHash: "a".repeat(64),
              sessionId: claim.sessionId,
              runId: claim.runId,
              turnClaim: claim,
              ownerEpoch: 3,
              rpcSetVersion: 1,
              protocolFeatures: [],
              credentialExpiresAtMs: Number.MAX_SAFE_INTEGER,
            };
            const handlers = createExecApprovalHandlers(fixture.manager);
            const attachIdentity = gatewayRequests.withAgentToolGatewayRuntimeIdentity;
            let capturedIdentity: AgentRuntimeIdentity | undefined;
            const identitySpy = vi
              .spyOn(gatewayRequests, "withAgentToolGatewayRuntimeIdentity")
              .mockImplementation((request, attachedIdentity) => {
                capturedIdentity = attachedIdentity;
                return attachIdentity(request, attachedIdentity);
              });
            const requestSpy = vi
              .spyOn(gatewayRequests, "callAgentToolGatewayRequest")
              .mockImplementation(
                async <T>(
                  request: Parameters<typeof gatewayRequests.callAgentToolGatewayRequest>[0],
                ): Promise<T> => {
                  if (!capturedIdentity) {
                    throw new Error("Worker runtime identity was not attached");
                  }
                  if (!isRecord(request.params)) {
                    throw new Error("Worker approval params must be an object");
                  }
                  const approvalIdentity = capturedIdentity;
                  const opts = requestOptions(approvalIdentity, () => check(approvalIdentity));
                  opts.params = request.params;
                  opts.req = {
                    type: "req",
                    method: request.method,
                    params: request.params,
                    id: "worker-bridge-request",
                  };
                  const canonicalHandler = handlers[request.method];
                  if (!canonicalHandler) {
                    throw new Error("Missing canonical approval handler");
                  }
                  return await new Promise<T>((resolve, reject) => {
                    opts.respond = (ok, payload, error) => {
                      if (ok) {
                        resolve(payload as T);
                      } else {
                        reject(new Error(error?.message ?? "Approval rejected"));
                      }
                    };
                    void fixture.track(Promise.resolve(canonicalHandler(opts))).catch(reject);
                  });
                },
              );
            try {
              await placements.authorizeWorkerTurnTools(claim, ["exec"]);
              bindWorkerTurnCapabilities(placements, claim, {
                execApprovalAllowed: true,
                toolSurface: {
                  applyPromptToolsAllow: vi.fn(),
                  getSurface: vi.fn(),
                  getPromptProjection: vi.fn(),
                  invoke: vi.fn(),
                  cancel: vi.fn(),
                  abort: vi.fn(),
                  close: vi.fn(),
                },
              });
              const gate = createWorkerSessionPlacementGate(placements);
              const bridge = createWorkerExecApprovalRpc({
                resolveGatewayContext: () => options.context,
                placementStore: gate,
                admit: () =>
                  gate.validateWorkerTurn(claim)
                    ? { ok: true }
                    : { ok: false, closeReason: "placement-mismatch" },
                now: Date.now,
              });
              const registration = await bridge.requestExecApproval(workerIdentity, {
                id: "worker-bridge-approval",
                command: "hostname",
                cwd: "/workspace/approval",
              });
              expect(registration.ok).toBe(true);
              if (!registration.ok) {
                throw new Error("Worker exec approval registration rejected");
              }
              const registered = registration.result;
              expect(Object.keys(registered).toSorted()).toEqual(["expiresAtMs", "id"]);
              expect(capturedIdentity).toMatchObject({
                agentId: source.agentId,
                sessionKey: source.sessionKey,
                delegatedAuthority: { kind: "worker", turnClaim: claim },
              });
              const workerRecord = await fixture.manager.getSnapshot(registered.id);
              expect(workerRecord?.request).toMatchObject({
                agentId: source.agentId,
                sessionKey: source.sessionKey,
                runId: claim.runId,
                unavailableDecisions: ["allow-always"],
              });
              const waiting = bridge.waitExecApprovalDecision(workerIdentity, {
                id: registered.id,
              });
              await fixture.manager.resolve(registered.id, "allow-once");
              expect(await waiting).toEqual({ ok: true, result: { decision: "allow-once" } });
              // Compose the actual placement exec constructor and worker transport with the
              // canonical approval owner. Only wire framing is adapted in this fixture.
              const workspace = path.join(fixture.databaseOptions.env.OPENCLAW_STATE_DIR, "worker");
              await mkdir(workspace, { recursive: true });
              for (const scenario of [
                "allow",
                "deny",
                "foreign",
                "aborted",
                "reconnected",
                "reassigned",
              ] as const) {
                const controller = new AbortController();
                const registeredApproval = Promise.withResolvers<string>();
                const waitStarted = Promise.withResolvers<void>();
                let connectionCurrent = true;
                let replacement: typeof claim | undefined;
                const commitAuthorization = execApprovals.commitExecAuthorizationLocked;
                const commitSpy =
                  scenario === "reconnected"
                    ? vi
                        .spyOn(execApprovals, "commitExecAuthorizationLocked")
                        .mockImplementation(async (params) => {
                          const authority = await commitAuthorization(params);
                          connectionCurrent = false;
                          return authority;
                        })
                    : undefined;
                testContext.onTestFinished(() => commitSpy?.mockRestore());
                const transport = createWorkerExecApprovalTransport(
                  {
                    captureExecApprovalAuthority: () => () => {
                      if (!connectionCurrent) {
                        throw new Error("worker connection changed");
                      }
                    },
                    async requestExecApproval(request) {
                      const response = await bridge.requestExecApproval(
                        workerIdentity,
                        request,
                        controller.signal,
                      );
                      if (!response.ok) {
                        throw new Error(`Approval registration rejected: ${response.closeReason}`);
                      }
                      if (scenario === "foreign") {
                        expect(
                          await bridge.waitExecApprovalDecision(
                            {
                              ...workerIdentity,
                              credentialHash: "another-worker-credential",
                            },
                            { id: response.result.id },
                          ),
                        ).toMatchObject({ ok: false });
                      }
                      registeredApproval.resolve(response.result.id);
                      return { type: "res", id: "register", ok: true, payload: response.result };
                    },
                    async requestExecApprovalDecision(request) {
                      const response = bridge.waitExecApprovalDecision(
                        workerIdentity,
                        request,
                        controller.signal,
                      );
                      waitStarted.resolve();
                      const result = await response;
                      if (!result.ok) {
                        throw new Error(`Approval decision rejected: ${result.closeReason}`);
                      }
                      // The parent lifetime can end after the canonical decision was consumed.
                      if (scenario === "aborted") {
                        controller.abort(new Error("worker connection closed"));
                      }
                      return { type: "res", id: "wait", ok: true, payload: result.result };
                    },
                  },
                  controller.signal,
                );
                const tools = createWorkerPlacementTools({
                  policy: {
                    workspaceOnly: true,
                    readOnly: false,
                    applyPatchEnabled: false,
                    applyPatchWorkspaceOnly: true,
                    imageSanitization: {},
                  },
                  cwd: workspace,
                  containmentRoot: workspace,
                  execAuthority: { host: "gateway", security: "allowlist", ask: "always" },
                  agentId: source.agentId,
                  sessionKey: source.sessionKey,
                  sessionId: source.sessionId,
                  runId: claim.runId,
                  approvalTransport: transport,
                });
                const exec = tools.find((tool) => tool.name === "exec");
                if (!exec) {
                  throw new Error("Placement exec tool missing");
                }
                const marker = path.join(workspace, `${scenario}.txt`);
                const execution = exec.execute(
                  `marker-${scenario}`,
                  {
                    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
                      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'worker-local')`,
                    )}`,
                    workdir: workspace,
                  },
                  controller.signal,
                );
                // Observe rejection immediately, including cancellation before spawn.
                const settled = execution.then(
                  (result) => ({ result, error: undefined }),
                  (error: unknown) => ({ result: undefined, error }),
                );
                const approvalId = await awaitGateBeforeSettlement(
                  registeredApproval.promise,
                  execution,
                  "Exec finished before registering approval",
                );
                await awaitGateBeforeSettlement(
                  waitStarted.promise,
                  execution,
                  "Exec finished before waiting for approval",
                );
                await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
                if (scenario === "reassigned") {
                  await placements.releaseTurn(claim);
                  replacement = await placements.claimTurn({
                    ...source,
                    claimId: "replacement-approval-claim",
                    runId: "replacement-approval-run",
                    owner: {
                      kind: "worker",
                      environmentId: workerIdentity.environmentId,
                      ownerEpoch: 3,
                    },
                  });
                }
                await fixture.manager.resolve(
                  approvalId,
                  scenario === "deny" ? "deny" : "allow-once",
                );
                const outcome = await settled;
                commitSpy?.mockRestore();
                if (replacement) {
                  await placements.releaseTurn(replacement);
                }
                if (scenario === "allow" || scenario === "foreign") {
                  expect(outcome.error).toBeUndefined();
                  await expect(readFile(marker, "utf8")).resolves.toBe("worker-local");
                } else {
                  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
                  if (scenario === "aborted") {
                    expect(outcome.error).toBeUndefined();
                    expect(outcome.result).toMatchObject({
                      details: {
                        status: "failed",
                        exitCode: null,
                        aggregated: expect.stringContaining("approval-request-failed"),
                      },
                    });
                  }
                  if (scenario === "reconnected") {
                    expect(outcome.error).toMatchObject({ message: "worker connection changed" });
                  }
                }
              }
              bridge.clear();
            } finally {
              requestSpy.mockRestore();
              identitySpy.mockRestore();
            }
          }
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
