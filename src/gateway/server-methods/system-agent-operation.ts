import type { SystemAgentChatParams } from "../../../packages/gateway-protocol/src/index.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { defaultRuntime } from "../../runtime.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { SystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { verifySystemAgentInferenceWithFallback } from "../../system-agent/inference-fallback.js";
import {
  isSystemAgentConfigOperation,
  type SystemAgentOperation,
} from "../../system-agent/operation-types.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewaySystemAgentSession } from "./shared-types.js";
import { prepareDelegatedSystemAgentApproval } from "./system-agent-approval.js";
import { buildSystemAgentChatResult } from "./system-agent-chat-turn.js";
import { runSystemAgentGatewayTask } from "./system-agent-execution.js";
import {
  evictOldestSystemAgentSession,
  resolveSystemAgentSessionOwnerKey,
} from "./system-agent-session-owner.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** An admitted regular-agent tool call, not another model conversation. */
export async function runSystemAgentOperationInput(
  options: GatewayRequestHandlerOptions,
  params: SystemAgentChatParams,
  operation: SystemAgentOperation,
): Promise<void> {
  const { context, client, respond } = options;
  const authority = readGatewayRequestMutationAuthority(options);
  const sessions = context.systemAgentSessions;
  let session: GatewaySystemAgentSession | undefined;
  try {
    const outcome = await runSystemAgentGatewayTask(async () => {
      authority.assertCurrent();
      if (!params.delegation || sessions.has(params.sessionId)) {
        throw new Error("Typed OpenClaw operations require a fresh requesting-tool invocation.");
      }
      const ownerKey = resolveSystemAgentSessionOwnerKey({ delegation: params.delegation, client });
      if (!ownerKey) {
        throw new Error("OpenClaw caller identity unavailable.");
      }
      // Preserve the existing live inference-owner guard for non-config operations.
      // Exact configuration already has an inference-independent recovery contract.
      const inference = isSystemAgentConfigOperation(operation)
        ? undefined
        : await verifySystemAgentInferenceWithFallback({
            requestingAgentId: params.delegation.agentId,
            runtime: defaultRuntime,
          });
      if (inference && !inference.ok) {
        throw new SystemAgentInferenceUnavailableError("conversation", [inference.error]);
      }
      const engine = new SystemAgentChatEngine({
        surface: "gateway",
        operatorApprovalOnly: true,
        requesterAgentId: params.delegation.agentId,
        deps: {
          gatewayHostLifecycle: context.hostLifecycle,
          applyPluginRuntime: context.applyPluginLifecycleChange,
        },
        ...(inference?.ok
          ? { verifiedInference: inference.binding }
          : {
              prepareInference: async () => {
                throw new Error("Exact configuration does not require helper inference.");
              },
            }),
      });
      await evictOldestSystemAgentSession(sessions, context);
      authority.assertCurrent();
      session = { engine, welcome: "", operationInput: true, ownerKey, lastUsedAt: Date.now() };
      sessions.set(params.sessionId, session);
      const resolveProposal = await prepareDelegatedSystemAgentApproval({
        context,
        sessions,
        session,
        sessionId: params.sessionId,
        delegation: params.delegation,
      });
      const reply = await engine.handleOperation(operation);
      const proposal = engine.getPendingOperatorProposal();
      return proposal ? await resolveProposal(proposal) : { kind: "completed" as const, reply };
    });
    // The existing approval owner reenters the task lane; never hold it while a human decides.
    const reply =
      outcome.kind === "approval"
        ? await racePromiseWithAbortSignal(outcome.completion, getAsyncWorkSignal())
        : outcome.reply;
    authority.assertCurrent();
    respond(true, buildSystemAgentChatResult({ sessionId: params.sessionId, reply }), undefined);
  } finally {
    if (session && sessions.get(params.sessionId) === session) {
      sessions.delete(params.sessionId);
      if (session.pendingApproval) {
        await context.systemAgentApprovalManager?.expire(
          session.pendingApproval.id,
          "session-reset",
        );
      }
      await session.engine.dispose();
    }
  }
}
