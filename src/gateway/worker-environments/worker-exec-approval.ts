import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type {
  WorkerExecApprovalParams,
  WorkerExecApprovalResult,
} from "../../../packages/gateway-protocol/src/schema/worker-exec-approval.js";
import { resolveExecReviewerDefaults } from "../../agents/bash-tools.exec-support.js";
import { buildExecAutoReviewTranscript } from "../../agents/exec-auto-review-transcript.js";
import { createModelExecAutoReviewer } from "../../agents/exec-auto-reviewer.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  withAgentToolGatewayRuntimeIdentity,
} from "../../agents/tools/in-process-gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals-core.js";
import type { ExecAutoReviewTranscript } from "../../infra/exec-auto-review.js";
import type { WorkerToolAuthority } from "../../worker/launch-descriptor.js";
import { workerExecApprovalDigest } from "../../worker/worker-exec-approval-binding.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  getWorkerTurnExecApproval,
  assertWorkerTurnInputAdmitted,
} from "./placement-turn-claim-events.js";
import type {
  WorkerExecApprovalOwner,
  WorkerExecApprovalTurnSource,
} from "./worker-exec-approval-contract.js";
import type { WorkerTurnRpcOptions } from "./worker-turn-rpc.types.js";

type Registration = { id: string; expiresAtMs: number; decision?: "allow-once" | "deny" | null };
type Decision = { decision: "allow-once" | "deny" | null; terminalReason?: string };

/** Retained by the admitted turn, with the same configured reviewer as local exec. */
export function createWorkerExecApprovalOwner(params: {
  exec: WorkerToolAuthority["exec"];
  config: OpenClawConfig;
  agentId: string;
  signal: AbortSignal;
  transcript: () => ExecAutoReviewTranscript;
  turnSource?: WorkerExecApprovalTurnSource;
}): WorkerExecApprovalOwner {
  const pending = new Map<string, { binding: string; toolCallId: string }>();
  params.signal.addEventListener("abort", () => pending.clear(), { once: true });
  // Retain model/plugin preparation without replacing the approval RPC's caller scope.
  const review = AsyncLocalStorage.bind(
    createModelExecAutoReviewer({
      cfg: params.config,
      agentId: params.agentId,
      signal: params.signal,
      reviewer: resolveExecReviewerDefaults({
        defaults: { config: params.config },
        agentId: params.agentId,
      }),
    }),
  );
  return async (
    request: WorkerExecApprovalParams,
    authority: Parameters<WorkerExecApprovalOwner>[1],
  ): Promise<WorkerExecApprovalResult> => {
    const assertCurrent = () => {
      params.signal.throwIfAborted();
      authority.signal?.throwIfAborted();
      authority.assertCurrent();
    };
    assertCurrent();
    if (!params.exec || params.exec.host !== "gateway" || params.exec.security === "deny") {
      throw new Error("Worker turn has no exec authority");
    }
    const binding = workerExecApprovalDigest(request.binding);
    if (request.operation === "review") {
      if (params.exec.mode !== "auto" || params.exec.ask === "always") {
        throw new Error("Worker exec policy requires human approval");
      }
      const input = {
        ...request.review,
        command: request.binding.command,
        executionCommand: request.binding.execCommand,
        cwd: request.binding.cwd,
        host: "gateway" as const,
        transcript: params.transcript(),
        agent: { id: params.agentId },
      };
      assertCurrent();
      const decision = await review(input);
      assertCurrent();
      return { operation: "review", binding, decision };
    }
    if (request.operation === "request") {
      if (pending.has(request.id)) {
        throw new Error("Worker approval is already registered");
      }
      pending.set(request.id, { binding, toolCallId: request.toolCallId });
      try {
        assertCurrent();
        const registration = await authority.call<Registration>(
          "exec.approval.request",
          {
            id: request.id,
            command: request.binding.execCommand,
            cwd: request.binding.cwd,
            toolCallId: request.toolCallId,
            host: "gateway",
            security: params.exec.security,
            ask: params.exec.ask,
            unavailableDecisions: ["allow-always"],
            warningText: [
              `Execution target: remote worker ${authority.environmentId}.`,
              `Requested command: ${request.binding.command}`,
              request.warningText,
            ]
              .filter(Boolean)
              .join("\n"),
            twoPhase: true,
            timeoutMs: DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
          },
          params.turnSource,
        );
        assertCurrent();
        if (registration.id !== request.id) {
          throw new Error("Worker approval registration changed");
        }
        if (registration.decision !== undefined) {
          pending.delete(request.id);
        }
        return { operation: "request", binding, ...registration };
      } catch (error) {
        pending.delete(request.id);
        throw error;
      }
    }
    const registered = pending.get(request.id);
    if (
      !registered ||
      registered.binding !== binding ||
      registered.toolCallId !== request.toolCallId
    ) {
      throw new Error(
        "Worker approval does not match this turn and command. Retry the exec request.",
      );
    }
    pending.delete(request.id);
    assertCurrent();
    const decision = await authority.call<Decision>(
      "exec.approval.waitDecision",
      {
        id: request.id,
      },
      params.turnSource,
    );
    assertCurrent();
    return { operation: "wait", binding, ...decision };
  };
}

export function prepareWorkerExecApproval(params: {
  exec: WorkerToolAuthority["exec"];
  turn: SessionPlacementTurnParams;
  manager: { buildSessionContext(): { messages: AgentMessage[] } };
  signal: AbortSignal;
  placement: { agentId: string };
}) {
  const { turn, manager, signal, exec } = params;
  return createWorkerExecApprovalOwner({
    exec,
    config: turn.config ?? {},
    agentId: params.placement.agentId,
    signal,
    transcript: () =>
      buildExecAutoReviewTranscript({ messages: manager.buildSessionContext().messages }),
    turnSource: {
      turnSourceChannel: turn.messageChannel ?? turn.messageProvider,
      turnSourceTo: turn.currentMessagingTarget ?? turn.currentChannelId,
      turnSourceAccountId: turn.agentAccountId,
      turnSourceThreadId: turn.currentThreadTs,
    },
  });
}

export function createWorkerExecApprovalRpc(
  options: Pick<WorkerTurnRpcOptions, "placementStore" | "resolveGatewayContext">,
  validate: (
    identity: WorkerConnectionIdentity,
    epoch: number,
    request: { kind: "session-tool" },
  ) => { ok: boolean },
) {
  return async (
    identity: WorkerConnectionIdentity,
    request: WorkerExecApprovalParams,
    signal?: AbortSignal,
  ) => {
    const source = identity.turnClaim
      ? options.placementStore?.getExecutionIdentityCapability?.(identity.turnClaim)
      : undefined;
    const execOwner = getWorkerTurnExecApproval(identity);
    const assertCurrent = () => {
      signal?.throwIfAborted();
      const current = validate(identity, identity.ownerEpoch, {
        kind: "session-tool",
      });
      if (
        !current.ok ||
        !source ||
        !execOwner ||
        getWorkerTurnExecApproval(identity) !== execOwner ||
        !identity.turnClaim ||
        !options.placementStore?.isWorkerTurnToolAuthorized(identity.turnClaim, "exec")
      ) {
        throw new Error("Worker exec approval authority changed. Start a new turn.");
      }
      source.receiptAuthority();
      assertWorkerTurnInputAdmitted(identity);
    };
    assertCurrent();
    if (!source || !execOwner) {
      throw new Error("Worker exec approval owner is unavailable");
    }
    const result = await source.run((owner) =>
      withGatewayToolCallerIdentity(
        {
          ...owner,
          gatewayContextResolver: options.resolveGatewayContext,
          approvalAuthority: owner.delegatedAuthority,
          receiptAuthority: assertCurrent,
          workerTurnClaim: owner.turnClaim,
          workerTurnExecutionIdentityCapability: source,
          ...(signal ? { approvalSignals: [signal] } : {}),
        },
        () =>
          execOwner(request, {
            assertCurrent,
            signal,
            environmentId: identity.environmentId,
            call: async <T>(
              method: "exec.approval.request" | "exec.approval.waitDecision",
              params: Record<string, unknown>,
              turnSource: WorkerExecApprovalTurnSource | undefined,
            ) => {
              assertCurrent();
              if (!options.resolveGatewayContext?.()) {
                throw new Error("Owning Gateway is unavailable");
              }
              const response = await callAgentToolGatewayRequest<T>(
                withAgentToolGatewayRuntimeIdentity(
                  {
                    method,
                    params,
                    timeoutMs: null,
                    expectFinal: method !== "exec.approval.request",
                    signal,
                    assertDispatchCurrent: assertCurrent,
                  },
                  {
                    ...turnSource,
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
              return response;
            },
          }),
      ),
    );
    assertCurrent();
    return { ok: true as const, result };
  };
}
