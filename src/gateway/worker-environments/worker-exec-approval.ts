import type { WorkerProtocolCloseReason } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerExecApprovalParams,
  WorkerExecApprovalResult,
  WorkerExecApprovalDecisionParams,
  WorkerExecApprovalDecisionResult,
} from "../../../packages/gateway-protocol/src/schema/worker-exec-approval.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  withAgentToolGatewayRuntimeIdentity,
} from "../../agents/tools/in-process-gateway.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { sameWorkerSessionTurnClaim, type WorkerSessionTurnClaim } from "./placement-record.js";
import {
  isWorkerTurnExecApprovalAllowed,
  type WorkerTurnExecutionIdentityCapability,
} from "./placement-turn-claim-events.js";
import type { WorkerSessionPlacementGate } from "./placement-worker-gate.js";

type ApprovalBinding = {
  claim: WorkerSessionTurnClaim;
  credentialHash: string;
  expiresAtMs: number;
};

/** The existing approval owner handles delivery and decisions; this adapter binds its caller. */
function createWorkerExecApprovalBridge(params: {
  resolveGatewayContext: GatewayContextResolver;
  source: (identity: WorkerConnectionIdentity) => WorkerTurnExecutionIdentityCapability | undefined;
  assertCurrent: (identity: WorkerConnectionIdentity) => void;
  now: () => number;
}) {
  const approvals = new Map<string, ApprovalBinding>();
  const call = async <T>(
    identity: WorkerConnectionIdentity,
    method: "exec.approval.request" | "exec.approval.waitDecision",
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const capability = params.source(identity);
    if (!capability) {
      throw new Error("Worker exec approval has no operational owner");
    }
    const assertCurrent = () => {
      signal?.throwIfAborted();
      params.assertCurrent(identity);
      capability.receiptAuthority();
    };
    assertCurrent();
    return await capability.run((owner) =>
      withGatewayToolCallerIdentity(
        {
          ...owner,
          gatewayContextResolver: params.resolveGatewayContext,
          approvalAuthority: owner.delegatedAuthority,
          receiptAuthority: assertCurrent,
          workerTurnClaim: owner.turnClaim,
          workerTurnExecutionIdentityCapability: capability,
          ...(signal ? { approvalSignals: [signal] } : {}),
        },
        async () => {
          assertCurrent();
          const result = await callAgentToolGatewayRequest<T>(
            withAgentToolGatewayRuntimeIdentity(
              {
                method,
                params: request,
                timeoutMs: null,
                expectFinal: method !== "exec.approval.request",
                signal,
                assertDispatchCurrent: assertCurrent,
              },
              {
                kind: "agentRuntime",
                agentId: owner.agentId,
                sessionKey: owner.sessionKey,
                operationalRunInstance: owner.operationalRunInstance,
                delegatedAuthority: {
                  kind: "worker",
                  ...owner.delegatedAuthority,
                  turnClaim: owner.turnClaim,
                },
                executionIdentity: owner.executionIdentityToken,
              },
            ),
          );
          assertCurrent();
          return result;
        },
      ),
    );
  };
  return {
    async request(
      identity: WorkerConnectionIdentity,
      request: WorkerExecApprovalParams,
      signal?: AbortSignal,
    ): Promise<WorkerExecApprovalResult> {
      params.assertCurrent(identity);
      const claim = identity.turnClaim;
      if (!claim) {
        throw new Error("Worker exec approval requires an attached turn");
      }
      for (const [id, binding] of approvals) {
        if (binding.expiresAtMs <= params.now()) {
          approvals.delete(id);
        }
      }
      if (approvals.has(request.id)) {
        throw new Error("Worker exec approval ID is already registered");
      }
      // Reserve before yielding so another worker cannot race this registration.
      const binding: ApprovalBinding = {
        claim,
        credentialHash: identity.credentialHash,
        expiresAtMs: params.now() + DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
      };
      approvals.set(request.id, binding);
      try {
        const result = await call<WorkerExecApprovalResult>(
          identity,
          "exec.approval.request",
          {
            id: request.id,
            command: request.command,
            cwd: request.cwd,
            toolCallId: request.toolCallId,
            host: "gateway",
            security: "allowlist",
            ask: "always",
            warningText: [
              `Execution target: remote worker ${identity.environmentId}; this command runs in its workspace, not on the Gateway.`,
              request.warningText,
            ]
              .filter(Boolean)
              .join("\n"),
            unavailableDecisions: ["allow-always"],
            twoPhase: true,
            timeoutMs: DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
          },
          signal,
        );
        if (result.id !== request.id) {
          throw new Error("Worker exec approval registration identity changed");
        }
        binding.expiresAtMs = result.expiresAtMs;
        if (result.decision !== undefined) {
          approvals.delete(request.id);
          if (
            result.decision !== null &&
            result.decision !== "allow-once" &&
            result.decision !== "deny"
          ) {
            throw new Error("Unsupported worker exec approval decision");
          }
        }
        return {
          id: result.id,
          expiresAtMs: result.expiresAtMs,
          ...(result.decision !== undefined ? { decision: result.decision } : {}),
        };
      } catch (error) {
        approvals.delete(request.id);
        throw error;
      }
    },
    async waitDecision(
      identity: WorkerConnectionIdentity,
      request: WorkerExecApprovalDecisionParams,
      signal?: AbortSignal,
    ): Promise<WorkerExecApprovalDecisionResult> {
      params.assertCurrent(identity);
      const binding = approvals.get(request.id);
      if (
        !binding ||
        !identity.turnClaim ||
        binding.credentialHash !== identity.credentialHash ||
        !sameWorkerSessionTurnClaim(binding.claim, identity.turnClaim)
      ) {
        throw new Error("Worker exec approval does not belong to this turn");
      }
      // Consume before yielding: one registration authorizes exactly one decision wait.
      approvals.delete(request.id);
      const result = await call<WorkerExecApprovalDecisionResult>(
        identity,
        "exec.approval.waitDecision",
        { id: request.id },
        signal,
      );
      // Persistent host grants are not portable to a worker's isolated approval store.
      if (
        result.decision !== null &&
        result.decision !== "allow-once" &&
        result.decision !== "deny"
      ) {
        throw new Error("Unsupported worker exec approval decision");
      }
      return {
        decision: result.decision,
        ...(result.terminalReason === "run-aborted"
          ? { terminalReason: result.terminalReason }
          : {}),
      };
    },
    clear: () => approvals.clear(),
  };
}

/** Attach approval RPC to the same live admission and tool grant as other worker calls. */
export function createWorkerExecApprovalRpc(params: {
  resolveGatewayContext?: GatewayContextResolver;
  placementStore?: WorkerSessionPlacementGate;
  admit: (
    identity: WorkerConnectionIdentity,
  ) => { ok: true } | { ok: false; closeReason?: WorkerProtocolCloseReason };
  now: () => number;
}) {
  const validate = (identity: WorkerConnectionIdentity): WorkerProtocolCloseReason | undefined => {
    const admission = params.admit(identity);
    if (!admission.ok) {
      return admission.closeReason ?? "placement-mismatch";
    }
    if (
      !identity.turnClaim ||
      !isWorkerTurnExecApprovalAllowed(identity) ||
      !params.placementStore?.isWorkerTurnToolAuthorized(identity.turnClaim, "exec")
    ) {
      return "method-not-allowed";
    }
    return undefined;
  };
  const bridge = params.resolveGatewayContext
    ? createWorkerExecApprovalBridge({
        resolveGatewayContext: params.resolveGatewayContext,
        source: (identity) =>
          identity.turnClaim
            ? params.placementStore?.getExecutionIdentityCapability?.(identity.turnClaim)
            : undefined,
        now: params.now,
        assertCurrent: (identity) => {
          const reason = validate(identity);
          if (reason) {
            throw new Error(`Worker exec approval authority closed: ${reason}`);
          }
        },
      })
    : undefined;
  const run = async <T>(
    identity: WorkerConnectionIdentity,
    operation: (current: NonNullable<typeof bridge>) => Promise<T>,
  ) => {
    const invalid = validate(identity);
    if (invalid) {
      return { ok: false as const, closeReason: invalid };
    }
    if (!bridge) {
      return { ok: false as const, closeReason: "gateway-unavailable" as const };
    }
    try {
      const result = await operation(bridge);
      const stale = validate(identity);
      return stale ? { ok: false as const, closeReason: stale } : { ok: true as const, result };
    } catch {
      return {
        ok: false as const,
        closeReason: validate(identity) ?? ("gateway-unavailable" as const),
      };
    }
  };
  return {
    requestExecApproval: (
      identity: WorkerConnectionIdentity,
      request: WorkerExecApprovalParams,
      signal?: AbortSignal,
    ) => run(identity, (current) => current.request(identity, request, signal)),
    waitExecApprovalDecision: (
      identity: WorkerConnectionIdentity,
      request: WorkerExecApprovalDecisionParams,
      signal?: AbortSignal,
    ) => run(identity, (current) => current.waitDecision(identity, request, signal)),
    clear: () => bridge?.clear(),
  };
}
