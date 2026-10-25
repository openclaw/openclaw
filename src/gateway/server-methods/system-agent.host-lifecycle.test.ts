// Register shared mocks before loading the engine and request handlers.
import "./system-agent.mocks.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createGatewayHostLifecycle } from "../../cli/gateway-cli/host-lifecycle.js";
import { prepareHostedGatewayStop, type HostedGatewayStop } from "../../daemon/hosted-stop.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import * as systemAgentAudit from "../../system-agent/audit.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { readLastSystemAgentAuditEntry } from "../../system-agent/system-agent.test-helpers.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { WorkerSessionTurnClaim } from "../worker-environments/placement-record.js";
import { runSystemAgentGatewayTask } from "./system-agent-execution.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import {
  defaultClient,
  makeContext,
  makeRespond,
  systemAgentLane,
  transcriptStoreMocks,
  useSystemAgentGatewayTestFixture,
  verifiedConfig,
} from "./system-agent.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

vi.mock("../../daemon/hosted-stop.js", () => ({ prepareHostedGatewayStop: vi.fn() }));

const {
  systemAgentTempDirs,
  requireVerifiedInferenceFixture,
  installVerifiedConfigReader,
  seededSession,
} = useSystemAgentGatewayTestFixture();

it.for([
  { fullPermission: false, loss: "none" },
  { fullPermission: true, loss: "none" },
  { fullPermission: false, loss: "run" },
  ...(["run", "tool", "gateway", "worker", "session"] as const).map((loss) => ({
    fullPermission: true,
    loss,
  })),
] as const)(
  "settles delegated stop through host acceptance (Full Access=$fullPermission, loss=$loss)",
  async ({ fullPermission, loss }, testContext) => {
    const approvalRequested = createDeferred();
    const preparationStarted = createDeferred();
    const releasePreparation = createDeferred();
    const auditStarted = createDeferred();
    const releaseAudit = createDeferred();
    const delegation = { agentId: "main", sessionKey: "agent:main:main" };
    const stateDir = systemAgentTempDirs.make("openclaw-delegated-gateway-lifecycle-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(verifiedConfig));
    const nativeEffect = vi.fn<HostedGatewayStop["execute"]>(async (assertCurrent) => {
      assertCurrent();
      return { outcome: "accepted" };
    });
    const dispose = vi.fn<HostedGatewayStop["dispose"]>().mockResolvedValue(undefined);
    vi.mocked(prepareHostedGatewayStop).mockImplementation(async (_owner, assertCaller) => {
      assertCaller();
      preparationStarted.resolve();
      await releasePreparation.promise;
      // The real host owner must revalidate before accepting this prepared intent.
      return { execute: nativeEffect, dispose };
    });
    let serving = true;
    const acceptStop = vi.fn(() => {
      serving = false;
    });
    const host = createGatewayHostLifecycle({
      isCurrent: () => true,
      isServing: () => serving,
      processOwner: { ownsProcessLifecycle: true, supervisor: null },
      acceptStop,
    });
    const appendAudit = systemAgentAudit.appendSystemAgentAuditEntry;
    vi.spyOn(systemAgentAudit, "appendSystemAgentAuditEntry").mockImplementation(async (entry) => {
      auditStarted.resolve();
      await releaseAudit.promise;
      return await appendAudit(entry);
    });
    installVerifiedConfigReader();
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      surface: "gateway",
      verifiedInference: requireVerifiedInferenceFixture(),
      deps: { gatewayHostLifecycle: host.capability },
    });
    engine.propose({ kind: "gateway-stop" });
    const proposalHash = expectDefined(
      engine.getPendingOperatorProposal(),
      "lifecycle proposal",
    ).hash;
    vi.spyOn(engine, "handle").mockResolvedValue({ text: "Approval pending.", action: "none" });
    const delegatedSession = seededSession({
      engine,
      ownerKey: JSON.stringify(["main", "agent:main:main"]),
    });
    const sessions = new Map<string, SystemAgentChatSession>([["delegate-1", delegatedSession]]);
    let workerActive = true;
    const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: (authority) =>
        validateAgentRunDelegatedAuthority(authority) && workerActive,
    });
    const operationalRunInstance = createOperationalRunInstanceRef(
      "delegated-gateway-lifecycle-run",
    );
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const controller = new AbortController();
    const broadcast = vi.fn((event: string) => {
      if (event === "openclaw.approval.requested") {
        approvalRequested.resolve();
      }
    });
    const context = {
      ...makeContext(sessions),
      systemAgentApprovalManager: manager,
      broadcast,
      broadcastToConnIds: vi.fn(),
      hasExecApprovalClients: () => true,
      validateAgentRuntimeApprovalAuthority: () => workerActive,
    } as unknown as GatewayRequestContext;
    let liveContext = context;
    const workerTurnClaim: WorkerSessionTurnClaim = {
      sessionId: "delegate-1",
      claimId: "hosted-stop-turn",
      runId: operationalRunInstance.runId,
      placementGeneration: 1,
      owner: { kind: "worker", environmentId: "worker-1", ownerEpoch: 1 },
    };
    const identity = {
      ...delegation,
      operationalRunInstance,
      approvalAuthority: authority,
      fullPermission,
      gatewayContextResolver: () => liveContext,
      approvalSignals: [controller.signal],
      ...(loss === "worker" ? { workerTurnClaim } : {}),
    };
    const requestResponses = makeRespond();
    const rootsAtResponse: number[] = [];
    const persistedHistoryAtResponse: unknown[][] = [];
    const appendHistory = transcriptStoreMocks.appendTurn;
    const pendingChat = withGatewayToolCallerIdentity(identity, () =>
      handleGatewayRequest({
        req: gatewayRequest("delegated-gateway-lifecycle", "openclaw.chat", {
          sessionId: "delegate-1",
          message: "stop Gateway.",
          context: { page: "channels" },
          delegation,
        }),
        respond: (ok, payload, error) => {
          rootsAtResponse.push(getActiveGatewayRootWorkCount());
          persistedHistoryAtResponse.push(appendHistory.mock.calls.map(([turn]) => turn));
          requestResponses.respond(ok, payload, error);
        },
        client: {
          ...defaultClient,
          connect: { ...defaultClient.connect, role: "operator", scopes: ["operator.admin"] },
        } as GatewayClient,
        isWebchatConnect: () => false,
        context,
        extraHandlers: { "openclaw.chat": systemAgentHandlers["openclaw.chat"]! },
      }),
    );
    const beforeReply = (gate: Promise<unknown>, stage: string) =>
      awaitGateBeforeSettlement(gate, pendingChat, `Delegated lifecycle replied before ${stage}`);
    const expectPending = (activeCount: number, roots?: number) => {
      expect(requestResponses.calls).toHaveLength(0);
      if (roots === undefined) {
        expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
      } else {
        expect(getActiveGatewayRootWorkCount()).toBe(roots);
      }
      expect(systemAgentLane()).toMatchObject({ activeCount, queuedCount: 0 });
    };
    try {
      if (!fullPermission) {
        await beforeReply(approvalRequested.promise, "approval publication");
        await runSystemAgentGatewayTask(async () => undefined);
        const pendingRecords = await manager.listPendingRecords();
        expect(pendingRecords).toHaveLength(1);
        expectPending(0, 1);
        const proposalId = expectDefined(pendingRecords[0], "pending approval").id;
        expect(await manager.getSnapshot(proposalId)).toMatchObject({
          request: { proposalHash, ...delegation },
        });
        expect(acceptStop).not.toHaveBeenCalled();
        expect(nativeEffect).not.toHaveBeenCalled();
        expect(await manager.resolve(proposalId, "allow-once", "operator-ui")).toBe(true);
      }
      await beforeReply(preparationStarted.promise, "host preparation");
      expectPending(1);
      expect(delegatedSession.pendingApproval).toBeUndefined();
      expect(acceptStop).not.toHaveBeenCalled();
      expect(nativeEffect).not.toHaveBeenCalled();
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
      if (fullPermission) {
        expect(await manager.listPendingRecords()).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
      }
      if (loss === "run") {
        expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
      } else if (loss === "tool") {
        controller.abort();
      } else if (loss === "gateway") {
        liveContext = { ...context };
      } else if (loss === "worker") {
        workerActive = false;
      } else if (loss === "session") {
        sessions.set("delegate-1", { ...delegatedSession });
      }
      releasePreparation.resolve();
      if (loss === "none") {
        await auditStarted.promise;
        expect(acceptStop).toHaveBeenCalledOnce();
        expect(nativeEffect).not.toHaveBeenCalled();
        expect(requestResponses.calls).toHaveLength(0);
        expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
        expect(readLastSystemAgentAuditEntry()).toBeUndefined();
      }
      releaseAudit.resolve();
      await pendingChat;
      const expectedReply =
        loss === "none"
          ? "[openclaw] done: gateway.stop"
          : "system-agent approval authority is no longer active";
      expect(requestResponses.calls).toHaveLength(1);
      expect(rootsAtResponse[0]).toBeGreaterThan(0);
      const expectedTurn = expect.objectContaining({
        role: "assistant",
        text: expect.stringContaining(expectedReply),
      });
      expect(persistedHistoryAtResponse[0]).toContainEqual(expectedTurn);
      expect(requestResponses.calls[0]).toMatchObject({
        ok: true,
        payload: { reply: expect.stringContaining(expectedReply) },
      });
      expect(systemAgentLane()).toMatchObject({ activeCount: 0, queuedCount: 0 });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(appendHistory).toHaveBeenCalledWith(expectedTurn);
      expect(engine.getPendingOperatorProposal()).toBeNull();
      expect(nativeEffect).not.toHaveBeenCalled();
      if (loss !== "none") {
        expect(acceptStop).not.toHaveBeenCalled();
        expect(readLastSystemAgentAuditEntry()).toBeUndefined();
        expect(dispose).toHaveBeenCalledOnce();
        await expect(host.finishStop()).resolves.toEqual({ outcome: "retired" });
        expect(nativeEffect).not.toHaveBeenCalled();
      } else {
        expect(readLastSystemAgentAuditEntry()).toMatchObject({
          operation: "gateway.stop",
          summary: "Scheduled Gateway stop",
        });
        // The accepted intent survives its caller; run-loop tests own drain/close ordering.
        controller.abort();
        expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
        await expect(host.finishStop()).resolves.toEqual({ outcome: "accepted" });
        expect(nativeEffect).toHaveBeenCalledOnce();
      }
    } finally {
      releasePreparation.resolve();
      releaseAudit.resolve();
      controller.abort();
      for (const record of await manager.listPendingRecords()) {
        await manager.expire(record.id);
      }
      await Promise.allSettled([pendingChat]);
      await host.retire();
      await engine.dispose();
    }
  },
);
