// Covers exact delegated approval authority and closure fences.
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import type { SystemAgentOperation } from "../../system-agent/operation-types.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import type { WorkerSessionTurnClaim } from "../worker-environments/placement-record.js";
import { prepareDelegatedSystemAgentApproval } from "./system-agent-approval.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(() => {
  resetAgentRunRegistryForTest();
  clearRuntimeConfigSnapshot();
});

function approvalSession(
  proposal: NonNullable<ReturnType<SystemAgentChatSession["engine"]["getPendingOperatorProposal"]>>,
  resolveOperatorApproval: SystemAgentChatSession["engine"]["resolveOperatorApproval"],
) {
  return {
    engine: {
      historyLength: () => 0,
      historySince: () => [],
      noteAssistantMessage: vi.fn(),
      getPendingOperatorProposal: () => proposal,
      resolveOperatorApproval,
    },
    lastUsedAt: 1,
    ownerKey: "agent:main:main",
  } as unknown as SystemAgentChatSession;
}

async function resolveTestProposal(
  params: Parameters<typeof prepareDelegatedSystemAgentApproval>[0] & {
    proposal: NonNullable<
      ReturnType<SystemAgentChatSession["engine"]["getPendingOperatorProposal"]>
    >;
  },
) {
  const resolveProposal = await prepareDelegatedSystemAgentApproval(params);
  return await resolveProposal(params.proposal);
}

async function queueDelegatedApproval(
  params: Parameters<typeof resolveTestProposal>[0],
): Promise<string> {
  const resolution = await resolveTestProposal(params);
  if (resolution.kind !== "approval") {
    throw new Error("expected a human approval request");
  }
  return resolution.id;
}

function delegatedApproval(
  testContext: TestContext,
  resolveOperatorApproval = vi.fn().mockResolvedValue(null),
  worker?: { active: boolean },
  events = true,
  operation: SystemAgentOperation = { kind: "gateway-restart" },
) {
  const proposal = { operation, hash: "a".repeat(64) };
  const session = approvalSession(proposal, resolveOperatorApproval);
  const sessionId = worker ? "delegate-worker" : "delegate";
  const sessions = new Map([[sessionId, session]]);
  const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
    approvalKind: "system-agent",
    resolveAllowedDecisions: (request) => request.allowedDecisions,
    validateAgentRuntimeDelegatedAuthority: (authority) =>
      validateAgentRunDelegatedAuthority(authority) && (worker?.active ?? true),
  });
  const publishResolved = vi.fn();
  const context = {
    systemAgentApprovalManager: manager,
    broadcast: vi.fn(),
    ...(events ? { approvalEvents: { publishRequested: vi.fn(), publishResolved } } : {}),
    ...(worker ? { validateAgentRuntimeApprovalAuthority: () => worker.active } : {}),
  } as unknown as GatewayRequestContext;
  const operationalRunInstance = createOperationalRunInstanceRef(
    worker ? "delegated-worker-run" : "delegated-run",
  );
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const queue = (workerTurnClaim?: WorkerSessionTurnClaim, fullPermission?: boolean) =>
    withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        ...(workerTurnClaim ? { workerTurnClaim } : {}),
        ...(fullPermission === undefined
          ? {}
          : {
              fullPermission,
              assertAutoApproveChangesCurrent: fullPermission ? () => {} : undefined,
            }),
      },
      () =>
        queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId,
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        }),
    );
  return { proposal, session, manager, publishResolved, authority, queue };
}

describe("prepareDelegatedSystemAgentApproval", () => {
  const grantChanges: [SystemAgentOperation, OpenClawConfig | undefined, string[]][] = [
    [
      {
        kind: "config-set",
        path: "agents.entries.research.tools.openclaw.autoApproveChanges",
        value: "true",
      },
      { agents: { entries: { research: { tools: { openclaw: { autoApproveChanges: false } } } } } },
      [
        "from false to true",
        "Approving saves standing authorization",
        "future permitted delegated changes",
        "operator configuration",
      ],
    ],
    ...[true, false].map((global): [SystemAgentOperation, OpenClawConfig, string[]] => [
      { kind: "config-unset", path: "agents.entries.research.tools.openclaw.autoApproveChanges" },
      {
        tools: { openclaw: { autoApproveChanges: global } },
        agents: { entries: { research: { tools: { openclaw: { autoApproveChanges: !global } } } } },
      },
      [
        `inherit tools.openclaw.autoApproveChanges: ${global}`,
        global ? "standing authorization" : "individual approval",
      ],
    ]),
    [
      { kind: "config-unset", path: "tools.openclaw.autoApproveChanges" },
      { tools: { openclaw: { autoApproveChanges: false } } },
      ["removes tools.openclaw.autoApproveChanges", "Full Access", "per-agent overrides"],
    ],
    [
      { kind: "config-set", path: "agents.entries.research.tools", value: "{}" },
      undefined,
      [
        "may change tools.openclaw.autoApproveChanges or its per-agent overrides",
        "future approval behavior",
        "Review",
      ],
    ],
    [
      { kind: "config-set", path: "tools.openclaw.autoApproveChanges", value: "true" },
      undefined,
      ["sets tools.openclaw.autoApproveChanges to true", "Approving saves standing authorization"],
    ],
  ];
  it.for(grantChanges)(
    "delivers actionable grant-change guidance in the exact approval: %j",
    async ([operation, config, parts], testContext) => {
      if (config) {
        setRuntimeConfigSnapshot(config);
      }
      const { manager, session, queue } = delegatedApproval(
        testContext,
        vi.fn().mockResolvedValue(null),
        undefined,
        false,
        operation,
      );
      const id = await queue(undefined, true);
      try {
        const record = await manager.getSnapshot(id);
        for (const part of parts) {
          expect(record?.request.description).toContain(part);
        }
        expect(record?.request.description).toContain("autoApproveChanges");
      } finally {
        await manager.expire(id);
        await session.pendingApproval?.completion;
      }
    },
  );

  const workerTurnClaim = (claimId: string): WorkerSessionTurnClaim => ({
    sessionId: "delegate-worker",
    claimId,
    runId: "delegated-worker-run",
    placementGeneration: 1,
    owner: { kind: "worker", environmentId: "worker-1", ownerEpoch: 1 },
  });

  it("refuses to apply a delegated change after its run authority closes", async (testContext) => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "a".repeat(64),
    };
    const resolveOperatorApproval = vi.fn().mockResolvedValue(null);
    const session = approvalSession(proposal, resolveOperatorApproval);
    const sessions = new Map([["delegate-closed", session]]);
    const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-closed");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-closed",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);

    expect(approvalId).toBeTruthy();
    expect(await manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(false);
    expect((await manager.getSnapshot(approvalId!))?.status).toBe("cancelled");
    await vi.waitFor(() =>
      expect(resolveOperatorApproval).toHaveBeenCalledWith(
        null,
        proposal.hash,
        expect.any(Function),
        "cancelled",
      ),
    );
  });

  it("rechecks authority after queued approval work before the final effect", async (testContext) => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "b".repeat(64),
    };
    const applyStarted = createDeferred();
    const releaseApply = createDeferred();
    const applyEffect = vi.fn();
    const resolveOperatorApproval = vi.fn(
      async (
        _decision: "allow-once" | "allow-always" | "deny" | null,
        _proposalHash: string,
        beforePersistentApply?: () => void,
      ) => {
        if (_decision === null) {
          return null;
        }
        applyStarted.resolve();
        await releaseApply.promise;
        beforePersistentApply?.();
        applyEffect();
        return null;
      },
    );
    const session = approvalSession(proposal, resolveOperatorApproval);
    const sessions = new Map([["delegate-race", session]]);
    const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved },
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-race");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-race",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(await manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await applyStarted.promise;
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    releaseApply.resolve();
    const result = resolveOperatorApproval.mock.results[0]?.value;
    await expect(result).rejects.toThrow("system-agent approval authority is no longer active");
    expect(applyEffect).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "not-applied" }),
      ),
    );
  });

  it.each(["run", "tool", "gateway", "worker", "session", "grant"] as const)(
    "fences Full Access when its %s closes during apply preparation",
    async (owner) => {
      const started = createDeferred();
      const release = createDeferred();
      const effect = vi.fn();
      const proposal = { operation: { kind: "gateway-restart" as const }, hash: "f".repeat(64) };
      const session = {
        engine: {
          resolveOperatorApproval: async (
            decision: ExecApprovalDecision | null,
            _hash: string,
            assertCurrent?: () => void,
          ) => {
            if (decision === null) {
              return null;
            }
            started.resolve();
            await release.promise;
            assertCurrent?.();
            effect();
            return { text: "Applied", action: "none" as const, applied: true };
          },
        },
        ownerKey: "agent:main:main",
        lastUsedAt: 1,
      } as unknown as SystemAgentChatSession;
      const sessions = new Map([["delegate-full", session]]);
      let workerActive = true;
      let grantActive = true;
      const context = {
        systemAgentSessions: sessions,
        validateAgentRuntimeApprovalAuthority: () => workerActive,
      } as unknown as GatewayRequestContext;
      let liveContext = context;
      const operationalRunInstance = createOperationalRunInstanceRef("full-access-run");
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const controller = new AbortController();
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          approvalAuthority: authority,
          assertAutoApproveChangesCurrent: () => {
            if (!grantActive) {
              throw new Error("delegation grant revoked");
            }
          },
          gatewayContextResolver: () => liveContext,
          approvalSignals: [controller.signal],
          ...(owner === "worker" ? { workerTurnClaim: workerTurnClaim("full-turn") } : {}),
        },
        () =>
          resolveTestProposal({
            context,
            sessions,
            session,
            sessionId: "delegate-full",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          }),
      );
      await started.promise;
      if (owner === "run") {
        releaseAgentRunDelegatedAuthority(authority);
      } else if (owner === "tool") {
        controller.abort();
      } else if (owner === "gateway") {
        liveContext = { ...context };
      } else if (owner === "worker") {
        workerActive = false;
      } else if (owner === "grant") {
        grantActive = false;
      } else {
        sessions.set("delegate-full", { ...session });
      }
      release.resolve();

      await expect(pending).rejects.toThrow(
        owner === "grant"
          ? "delegation grant revoked"
          : "system-agent approval authority is no longer active",
      );
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("publishes the channel completion after the delegated change is applied", async (testContext) => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "c".repeat(64),
    };
    const resolveOperatorApproval = vi.fn().mockResolvedValue({
      text: "Applied",
      action: "none" as const,
      applied: true,
    });
    const session = approvalSession(proposal, resolveOperatorApproval);
    const sessions = new Map([["delegate-applied", session]]);
    const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved },
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-applied");
    claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-applied",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(await manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "applied" }),
      ),
    );
  });

  it("fences a delegated worker turn before the persistent effect", async (testContext) => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "d".repeat(64),
    };
    const applyStarted = createDeferred();
    const releaseApply = createDeferred();
    let workerTurnActive = true;
    const applyEffect = vi.fn();
    const resolveOperatorApproval = vi.fn(
      async (
        _decision: "allow-once" | "allow-always" | "deny" | null,
        _proposalHash: string,
        beforePersistentApply?: () => void,
      ) => {
        if (_decision === null) {
          return null;
        }
        applyStarted.resolve();
        await releaseApply.promise;
        beforePersistentApply?.();
        applyEffect();
        return null;
      },
    );
    const session = approvalSession(proposal, resolveOperatorApproval);
    const sessions = new Map([["delegate-worker", session]]);
    const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: (authority) =>
        validateAgentRunDelegatedAuthority(authority) && workerTurnActive,
    });
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved: vi.fn() },
      validateAgentRuntimeApprovalAuthority: () => workerTurnActive,
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-worker-run");
    claimAgentRunDelegatedAuthority(operationalRunInstance);
    const turnClaim = workerTurnClaim("turn-1");

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        workerTurnClaim: turnClaim,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-worker",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(await manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await applyStarted.promise;
    workerTurnActive = false;
    releaseApply.resolve();
    const result = resolveOperatorApproval.mock.results[0]?.value;
    await expect(result).rejects.toThrow("system-agent approval authority is no longer active");
    expect(applyEffect).not.toHaveBeenCalled();
  });

  it.for([true])(
    "reuses the exact worker approval with Full Access=%s",
    async (fullPermission, testContext) => {
      const proposal = {
        operation: { kind: "gateway-restart" as const },
        hash: "e".repeat(64),
      };
      const session = approvalSession(proposal, vi.fn().mockResolvedValue(null));
      const sessions = new Map([["delegate-worker", session]]);
      const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
        approvalKind: "system-agent",
        resolveAllowedDecisions: (request) => request.allowedDecisions,
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      });
      const context = {
        systemAgentApprovalManager: manager,
        broadcast: vi.fn(),
        validateAgentRuntimeApprovalAuthority: () => true,
      } as unknown as GatewayRequestContext;
      const operationalRunInstance = createOperationalRunInstanceRef("delegated-worker-run");
      claimAgentRunDelegatedAuthority(operationalRunInstance);

      const firstClaim = workerTurnClaim("turn-2");
      let firstApprovalId: string | undefined;
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          workerTurnClaim: firstClaim,
        },
        async () => {
          firstApprovalId = await queueDelegatedApproval({
            context,
            sessions,
            session,
            sessionId: "delegate-worker",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          });
        },
      );
      const secondClaim = workerTurnClaim("turn-2");
      let secondApprovalId: string | undefined;
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          workerTurnClaim: secondClaim,
          fullPermission,
        },
        async () => {
          secondApprovalId = await queueDelegatedApproval({
            context,
            sessions,
            session,
            sessionId: "delegate-worker",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          });
        },
      );

      expect(secondApprovalId).toBe(firstApprovalId);
      expect(await manager.listPendingRecords()).toHaveLength(1);
      expect(session.engine.resolveOperatorApproval).not.toHaveBeenCalled();
      const completion = session.pendingApproval?.completion;
      await manager.expire(firstApprovalId!);
      await completion;
    },
  );
});
