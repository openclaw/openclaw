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
  claimAgentRunApprovalAuthority,
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { DelegatedChangeApprovalRequiredError } from "../../system-agent/delegated-change-policy.js";
import type { SystemAgentOperation } from "../../system-agent/operation-types.js";
import { withAgentRuntimeAutomaticChangePolicyAssertion } from "../agent-runtime-automatic-change-policy.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
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

function pausedApply() {
  const started = createDeferred();
  const release = createDeferred();
  const effect = vi.fn();
  const resolve = vi.fn(
    async (decision: ExecApprovalDecision | null, _hash: string, assertCurrent?: () => void) => {
      if (decision === null) {
        return null;
      }
      started.resolve();
      await release.promise;
      assertCurrent?.();
      effect();
      return null;
    },
  );
  return { started, release, effect, resolve };
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
    const resolve = vi.fn().mockResolvedValue(null);
    const { proposal, manager, authority, queue } = delegatedApproval(
      testContext,
      resolve,
      undefined,
      false,
    );
    const approvalId = await queue();
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
    expect(await manager.resolve(approvalId, "allow-once", "operator-ui")).toBe(false);
    expect((await manager.getSnapshot(approvalId))?.status).toBe("cancelled");
    await vi.waitFor(() =>
      expect(resolve).toHaveBeenCalledWith(null, proposal.hash, expect.any(Function), "cancelled"),
    );
  });

  it("rechecks authority after queued approval work before the final effect", async (testContext) => {
    const apply = pausedApply();
    const { manager, publishResolved, authority, queue } = delegatedApproval(
      testContext,
      apply.resolve,
    );
    const approvalId = await queue();
    expect(await manager.resolve(approvalId, "allow-once", "operator-ui")).toBe(true);
    await apply.started.promise;
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    apply.release.resolve();
    await expect(apply.resolve.mock.results[0]?.value).rejects.toThrow(
      "system-agent approval authority is no longer active",
    );
    expect(apply.effect).not.toHaveBeenCalled();
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
          getPendingOperatorProposal: () => null,
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
          fullPermission: true,
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

  it.each([
    "active",
    "run",
    "tool",
    "gateway",
    "worker",
    "session",
    "global-policy",
    "agent-policy",
  ] as const)(
    "uses source-bound wire Full Access and fences the final effect after %s closure",
    async (owner) => {
      const started = createDeferred();
      const release = createDeferred();
      const effect = vi.fn();
      const proposal = { operation: { kind: "gateway-restart" as const }, hash: "w".repeat(64) };
      const session = {
        engine: {
          getPendingOperatorProposal: () => null,
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
      const sessions = new Map([["delegate-wire", session]]);
      let gatewayActive = true;
      let policyCurrent = true;
      const context = {
        systemAgentSessions: sessions,
        validateAgentRuntimeApprovalAuthority: () => gatewayActive,
      } as unknown as GatewayRequestContext;
      const operationalRunInstance = createOperationalRunInstanceRef("wire-full-access-run");
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const controller = new AbortController();
      const approvalAuthority =
        owner === "tool"
          ? claimAgentRunApprovalAuthority(authority, [controller.signal])
          : authority;
      const turnClaim = workerTurnClaim("wire-full-turn");
      const trustedAgentRuntime = withAgentRuntimeAutomaticChangePolicyAssertion(
        {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          delegatedAuthority:
            owner === "worker"
              ? { kind: "worker", ...approvalAuthority, turnClaim }
              : { kind: "local", ...approvalAuthority },
          fullPermission: true,
        } as AgentRuntimeIdentity,
        () => {
          // Stand-in for the host-owned delegate-tool closure, which re-reads live
          // auto-approval policy, agent overrides and execution containment.
          if (!policyCurrent) {
            throw new DelegatedChangeApprovalRequiredError(
              "OpenClaw requires human approval for this change.",
            );
          }
        },
      );

      const pending = resolveTestProposal({
        context,
        sessions,
        session,
        sessionId: "delegate-wire",
        delegation: { agentId: "main", sessionKey: "agent:main:main" },
        proposal,
        trustedAgentRuntime,
      });
      const startState = await Promise.race([
        started.promise.then(() => "started" as const),
        pending.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
      ]);
      expect(startState).toBe("started");
      if (owner === "run") {
        releaseAgentRunDelegatedAuthority(authority);
      } else if (owner === "tool") {
        controller.abort();
      } else if (owner === "gateway" || owner === "worker") {
        gatewayActive = false;
      } else if (owner === "session") {
        sessions.set("delegate-wire", { ...session });
      } else if (owner === "global-policy") {
        policyCurrent = false;
        setRuntimeConfigSnapshot({ tools: { openclaw: { autoApproveChanges: false } } });
      } else if (owner === "agent-policy") {
        policyCurrent = false;
        setRuntimeConfigSnapshot({
          tools: { openclaw: { autoApproveChanges: true } },
          agents: { entries: { main: { tools: { openclaw: { autoApproveChanges: false } } } } },
        });
      }
      release.resolve();

      if (owner === "active") {
        await expect(pending).resolves.toMatchObject({ kind: "completed" });
        expect(effect).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow(
          owner === "global-policy" || owner === "agent-policy"
            ? "requires human approval"
            : "system-agent approval authority is no longer active",
        );
        expect(effect).not.toHaveBeenCalled();
      }
    },
  );

  it("publishes the channel completion after the delegated change is applied", async (testContext) => {
    const resolve = vi.fn().mockResolvedValue({ text: "Applied", action: "none", applied: true });
    const { manager, publishResolved, queue } = delegatedApproval(testContext, resolve);
    expect(await manager.resolve(await queue(), "allow-once", "operator-ui")).toBe(true);
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "applied" }),
      ),
    );
  });

  it("fences a delegated worker turn before the persistent effect", async (testContext) => {
    const apply = pausedApply();
    const worker = { active: true };
    const { manager, queue } = delegatedApproval(testContext, apply.resolve, worker);
    const approvalId = await queue(workerTurnClaim("turn-1"));
    expect(await manager.resolve(approvalId, "allow-once", "operator-ui")).toBe(true);
    await apply.started.promise;
    worker.active = false;
    apply.release.resolve();
    await expect(apply.resolve.mock.results[0]?.value).rejects.toThrow(
      "system-agent approval authority is no longer active",
    );
    expect(apply.effect).not.toHaveBeenCalled();
  });

  it.for([
    {
      firstSource: "wire",
      secondSource: "wire",
      abortLease: "second",
      fullPermission: false,
      applies: true,
    },
    {
      firstSource: "ambient",
      secondSource: "wire",
      abortLease: "second",
      fullPermission: true,
      applies: true,
    },
    {
      firstSource: "wire",
      secondSource: "wire",
      abortLease: "first",
      fullPermission: false,
      applies: false,
    },
  ] as const)(
    "reuses $firstSource-to-$secondSource approval across leases without transferring its authority ($abortLease closes)",
    async ({ firstSource, secondSource, abortLease, fullPermission, applies }, testContext) => {
      const proposal = {
        operation: { kind: "gateway-restart" as const },
        hash: "e".repeat(64),
      };
      const resolveOperatorApproval = vi.fn().mockResolvedValue({
        text: "Applied",
        action: "none" as const,
        applied: true,
      });
      const session = approvalSession(proposal, resolveOperatorApproval);
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
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);

      const firstController = new AbortController();
      const secondController = new AbortController();
      const firstAuthority = claimAgentRunApprovalAuthority(authority, [firstController.signal]);
      const secondAuthority = claimAgentRunApprovalAuthority(authority, [secondController.signal]);
      expect(firstAuthority.claimId).not.toBe(secondAuthority.claimId);
      const turnClaim = workerTurnClaim("turn-2");
      const queueForAuthority = async (
        source: "ambient" | "wire",
        approvalAuthority: typeof firstAuthority,
        signal: AbortSignal,
        withFullPermission: boolean,
      ) => {
        const trustedAgentRuntime = {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          delegatedAuthority: { kind: "worker", ...approvalAuthority, turnClaim },
          ...(withFullPermission ? { fullPermission: true as const } : {}),
        } satisfies AgentRuntimeIdentity;
        const queue = () =>
          queueDelegatedApproval({
            context,
            sessions,
            session,
            sessionId: "delegate-worker",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
            ...(source === "wire" ? { trustedAgentRuntime } : {}),
          });
        return source === "wire"
          ? await queue()
          : await withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: "agent:main:main",
                operationalRunInstance,
                approvalAuthority,
                approvalSignals: [signal],
                workerTurnClaim: turnClaim,
                fullPermission: withFullPermission,
              },
              queue,
            );
      };
      const firstApprovalId = await queueForAuthority(
        firstSource,
        firstAuthority,
        firstController.signal,
        false,
      );
      const secondApprovalId = await queueForAuthority(
        secondSource,
        secondAuthority,
        secondController.signal,
        fullPermission,
      );

      expect(secondApprovalId).toBe(firstApprovalId);
      await expect(manager.listPendingRecords()).resolves.toHaveLength(1);
      await expect(manager.getSnapshot(firstApprovalId)).resolves.toMatchObject({
        agentRuntimeDelegatedAuthority: { claimId: firstAuthority.claimId },
      });
      expect(resolveOperatorApproval).not.toHaveBeenCalled();
      const completion = session.pendingApproval?.completion;
      expect(completion).toBeDefined();
      (abortLease === "first" ? firstController : secondController).abort();
      await expect(manager.resolve(firstApprovalId, "allow-once", "operator-ui")).resolves.toBe(
        applies,
      );
      await completion;
      if (applies) {
        expect(resolveOperatorApproval).toHaveBeenCalledWith(
          "allow-once",
          proposal.hash,
          expect.any(Function),
          undefined,
        );
      } else {
        expect(
          resolveOperatorApproval.mock.calls.some(([decision]) => decision === "allow-once"),
        ).toBe(false);
      }
    },
  );

  it("keeps the original approval applyable when an observer aborts before resolution", async (testContext) => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "f".repeat(64),
    };
    const resolveOperatorApproval = vi.fn().mockResolvedValue({
      text: "Applied",
      action: "none" as const,
      applied: true,
    });
    const session = {
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
    const sessionId = "delegate-observer";
    const sessions = new Map([[sessionId, session]]);
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
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-observer-run");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const ownerController = new AbortController();
    const observerController = new AbortController();
    const turnClaim = workerTurnClaim("turn-3");
    const ownerApprovalAuthority = claimAgentRunApprovalAuthority(authority, [
      ownerController.signal,
    ]);
    const prepareForLease = async (
      signal: AbortSignal,
      approvalAuthority = claimAgentRunApprovalAuthority(authority, [signal]),
    ) =>
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          approvalAuthority,
          approvalSignals: [signal],
          workerTurnClaim: turnClaim,
        },
        () =>
          prepareDelegatedSystemAgentApproval({
            context,
            sessions,
            session,
            sessionId,
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
          }),
      );

    const ownerResolution = await (
      await prepareForLease(ownerController.signal, ownerApprovalAuthority)
    )(proposal);
    if (ownerResolution.kind !== "approval") {
      throw new Error("expected a human approval request");
    }
    // Order matters: the observer must lose its lease after preparation reused the
    // pending decision and before it resolves the proposal it never owned.
    const resolveObserverProposal = await prepareForLease(observerController.signal);
    observerController.abort();
    await expect(resolveObserverProposal(proposal)).rejects.toThrow(
      "system-agent approval authority is no longer active",
    );

    expect(session.pendingApproval?.id).toBe(ownerResolution.id);
    await expect(manager.listPendingRecords()).resolves.toEqual([
      expect.objectContaining({ id: ownerResolution.id }),
    ]);
    await expect(manager.getSnapshot(ownerResolution.id)).resolves.toMatchObject({
      agentRuntimeDelegatedAuthority: { claimId: ownerApprovalAuthority.claimId },
    });
    expect(resolveOperatorApproval).not.toHaveBeenCalled();
    await expect(manager.resolve(ownerResolution.id, "allow-once", "operator-ui")).resolves.toBe(
      true,
    );
    await expect(ownerResolution.completion).resolves.toMatchObject({ applied: true });
    expect(resolveOperatorApproval).toHaveBeenCalledWith(
      "allow-once",
      proposal.hash,
      expect.any(Function),
      undefined,
    );
  });

  it("reuses the exact worker approval with Full Access", async (testContext) => {
    const { session, manager, queue } = delegatedApproval(
      testContext,
      vi.fn().mockResolvedValue(null),
      { active: true },
      false,
    );
    const firstApprovalId = await queue(workerTurnClaim("turn-2"));
    const secondApprovalId = await queue(workerTurnClaim("turn-2"), true);
    expect(secondApprovalId).toBe(firstApprovalId);
    expect(await manager.listPendingRecords()).toHaveLength(1);
    expect(session.engine.resolveOperatorApproval).not.toHaveBeenCalled();
    const completion = session.pendingApproval?.completion;
    await manager.expire(firstApprovalId);
    await completion;
  });
});
