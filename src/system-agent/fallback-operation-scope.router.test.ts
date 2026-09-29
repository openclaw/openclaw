import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  expectDefined,
  fakeOverviewLoader,
  fakePersistentApplyProof,
  sharedVerifiedInference,
} from "./chat-engine.test-support.js";
import { ChatTurnRouter } from "./chat-turn-router.js";
import { ChatWizardHost } from "./chat-wizard-host.js";
import { BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE } from "./fallback-operation-scope.js";
import { hashSystemAgentOperation, type SystemAgentProposalRef } from "./operator-approval.js";

function createRouter(
  fallback: boolean,
  directive?: {
    kind: "approved-operation";
    operation: { kind: "plugin-uninstall"; pluginId: string };
  },
) {
  const base = expectDefined(sharedVerifiedInference, "verified route test fixture");
  const binding = fallback
    ? { ...base, execution: { ...base.execution, fallbackModelRef: "stage/backup" } }
    : base;
  const executeOperation = vi.fn(async () => ({ applied: true }));
  const proposalRef: SystemAgentProposalRef = {};
  const session = {
    sessionId: "fallback-scope-test",
    verifiedInference: binding,
    proposalRef,
  };
  const router = new ChatTurnRouter(
    {
      runAgentTurn: async () => ({ text: "Proposed.", ...(directive ? { directive } : {}) }),
    },
    { executeOperation },
    session,
    new ChatWizardHost({ beforePersistentApply: async () => {} }),
    {
      requireVerifiedInference: async () => binding.execution,
      requirePersistentApplyInference: async () => fakePersistentApplyProof(),
      rebindVerifiedInference: () => {},
      getVerifiedInference: () => binding,
      loadOverview: fakeOverviewLoader(),
      verifyConfigAfterWrite: async () => null,
    },
  );
  return { router, executeOperation, session };
}

describe("bound fallback early operation scope", () => {
  it("rejects a direct agent proposal before generating an approval", () => {
    const { router, executeOperation } = createRouter(true);
    expect(router.propose({ kind: "create-agent", agentId: "helper" })).toBe(
      BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE,
    );
    expect(router.getPendingOperatorProposal()).toBeNull();
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("rejects a typed wizard handoff before any setup starts", async () => {
    const { router, executeOperation } = createRouter(true);
    const reply = await router.resolveTurn("connect telegram");
    expect(reply).toMatchObject({
      text: BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE,
      action: "none",
      applied: false,
    });
    expect(router.getPendingOperatorProposal()).toBeNull();
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("rejects a model-approved plugin mutation without constructing an effect", async () => {
    const { router, executeOperation } = createRouter(true, {
      kind: "approved-operation",
      operation: { kind: "plugin-uninstall", pluginId: "unrelated-plugin" },
    });
    const reply = await router.resolveAssistantTurn("remove the plugin", true);
    expect(reply.text).toContain(BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE);
    expect(reply.applied).toBe(false);
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("preserves a fallback's guarded config proposal and passes its route to the executor", async () => {
    const { router, executeOperation } = createRouter(true);
    router.propose({ kind: "config-set", path: "env.vars.STAGE", value: "local" });
    const proposal = router.getPendingOperatorProposal();
    expect(proposal).not.toBeNull();
    const reply = await router.resolveOperatorApproval("allow-once", proposal!.hash, () => {});
    expect(reply?.applied).toBe(true);
    expect(executeOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "config-set" }),
      expect.anything(),
      expect.objectContaining({ boundFallbackModelRef: "stage/backup", approved: true }),
    );
  });

  it("drops a tool-staged restricted fallback operation before operator approval", async () => {
    const { router, executeOperation, session } = createRouter(true);
    const staged = { kind: "plugin-uninstall", pluginId: "unrelated-plugin" } as const;
    session.proposalRef.operation = staged;
    session.proposalRef.current = hashSystemAgentOperation(staged);
    expect(router.getPendingOperatorProposal()).toBeNull();
    expect(session.proposalRef.current).toBeUndefined();
    expect(session.proposalRef.operation).toBeUndefined();
    session.proposalRef.operation = staged;
    session.proposalRef.current = hashSystemAgentOperation(staged);
    const reply = await router.resolveTurn("yes");
    expect(reply.applied).not.toBe(true);
    expect(router.getPendingOperatorProposal()).toBeNull();
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("does not narrow an independently verified primary owner", () => {
    const { router } = createRouter(false);
    expect(router.propose({ kind: "create-agent", agentId: "helper" })).toContain("helper");
    expect(router.getPendingOperatorProposal()).not.toBeNull();
  });
});
