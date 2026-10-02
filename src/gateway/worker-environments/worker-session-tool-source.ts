import { Value } from "typebox/value";
import { PresenceQueryParamsSchema } from "../../../packages/gateway-protocol/src/schema/presence.js";
import { SkillLibraryWorkshopSchema } from "../../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import {
  buildBlockedToolResult,
  runBeforeToolCallHook,
} from "../../agents/agent-tools.before-tool-call.js";
import { runAgentHarnessAfterToolCallHook } from "../../agents/harness/hook-helpers.js";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { buildSubagentExecutionSessionSpawnContext } from "../../agents/subagents/spawn/subagent-spawn-execution-identity.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
  withAgentToolGatewayRuntimeIdentity,
} from "../../agents/tools/in-process-gateway.js";
import { SessionPortalToolSchema } from "../../agents/tools/portal-tool-contract.js";
import { capturePresenceToolAuthority } from "../../agents/tools/presence-tool-authority.js";
import { runWithScopedSessionAccess } from "../../agents/tools/scoped-session-access.js";
import {
  PlacedSessionsSpawnSchema,
  PlacedSessionsSendSchema,
} from "../../agents/tools/sessions-placement-tool-contract.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import {
  workerSessionToolErrorResult as errorResult,
  type WorkerSessionToolRequest,
} from "./worker-session-tool-result.js";
import type { WorkerSessionToolSource as ExactSource } from "./worker-session-tool-topology.js";

export function workerSessionToolArguments(
  request: WorkerSessionToolRequest,
): Record<string, unknown> {
  if (request.toolName === "skill_workshop") {
    return request.request.arguments;
  }
  const { toolCallId: _toolCallId, ...args } = request.request;
  return args;
}

export function prepareWorkerSessionToolRequest(
  binding: Pick<WorkerSessionToolRequest, "identity" | "signal" | "onUpdate">,
  toolName: string,
  toolCallId: string,
  raw: unknown,
): WorkerSessionToolRequest | undefined {
  if (toolName === "sessions_spawn" && Value.Check(PlacedSessionsSpawnSchema, raw)) {
    return { ...binding, toolName, request: { ...raw, toolCallId } };
  }
  if (toolName === "sessions_send" && Value.Check(PlacedSessionsSendSchema, raw)) {
    return { ...binding, toolName, request: { ...raw, toolCallId } };
  }
  if (toolName === "portal" && Value.Check(SessionPortalToolSchema, raw)) {
    if (
      (raw.title?.length ?? 0) > 256 ||
      (raw.description?.length ?? 0) > 8 * 1024 ||
      (raw.path?.length ?? 0) > 1024 ||
      (raw.id?.length ?? 0) > 256
    ) {
      return undefined;
    }
    return { ...binding, toolName, request: { ...raw, toolCallId } };
  }
  if (toolName === "presence" && Value.Check(PresenceQueryParamsSchema, raw)) {
    return { ...binding, toolName, request: { ...raw, toolCallId } };
  }
  if (toolName === "skill_workshop" && Value.Check(SkillLibraryWorkshopSchema, raw)) {
    return { ...binding, toolName, request: { arguments: raw, toolCallId } };
  }
  return undefined;
}

export type WorkerSessionToolAuthority = {
  assertSource: () => void;
  collectExecutionIdentity: boolean;
  callGateway: <T = Record<string, unknown>>(
    request: Parameters<AgentToolGatewayRequestCaller>[0],
    sessionSpawnContext?: ReturnType<typeof buildSubagentExecutionSessionSpawnContext>,
  ) => Promise<T>;
};

export function createWorkerSessionToolSourceRunner(params: {
  resolveGatewayContext: GatewayContextResolver;
  placements: WorkerSessionPlacementStore;
}) {
  return async (
    operation: { source: ExactSource; request: WorkerSessionToolRequest },
    run: (
      authority: WorkerSessionToolAuthority,
      request: WorkerSessionToolRequest,
    ) => Promise<AgentToolResult<unknown>>,
  ): Promise<AgentToolResult<unknown>> => {
    const capability = getWorkerTurnExecutionIdentityCapability(
      params.placements,
      operation.source.turnClaim,
    );
    if (!capability) {
      throw new Error("Worker source turn has no operational owner");
    }
    return await runWithScopedSessionAccess({
      cfg: getRuntimeConfig(),
      agentId: operation.source.agentId,
      storePath: capability.sessionTarget.storePath,
      expectedSessionId: operation.source.sessionId,
      targetSessionKey: operation.source.sessionKey,
      ...(operation.request.signal ? { signal: operation.request.signal } : {}),
      run: () =>
        capability.run((owner) =>
          withGatewayToolCallerIdentity(
            {
              ...owner,
              gatewayContextResolver: params.resolveGatewayContext,
              approvalAuthority: owner.delegatedAuthority,
              workerTurnClaim: owner.turnClaim,
              workerTurnExecutionIdentityCapability: capability,
              ...(operation.request.signal ? { approvalSignals: [operation.request.signal] } : {}),
            },
            async () => {
              const assertPresenceSourceCurrent =
                operation.request.toolName === "presence"
                  ? (owner.assertPresenceSourceCurrent ?? capturePresenceToolAuthority())
                  : undefined;
              const assertSource = () => {
                operation.request.signal?.throwIfAborted();
                owner.receiptAuthority();
                assertPresenceSourceCurrent?.();
                const source = operation.source;
                if (
                  assertPresenceSourceCurrent &&
                  !params.placements.isWorkerTurnToolAuthorized(source.turnClaim, "presence")
                ) {
                  throw new Error("Worker session tool authority changed");
                }
                if (source.agentId !== owner.agentId || source.sessionKey !== owner.sessionKey) {
                  throw new Error("Worker source turn owner changed");
                }
              };
              const callGateway = async <R = Record<string, unknown>>(
                request: Parameters<AgentToolGatewayRequestCaller>[0],
                sessionSpawnContext?: ReturnType<typeof buildSubagentExecutionSessionSpawnContext>,
              ): Promise<R> => {
                assertSource();
                return await capability.run(() =>
                  callAgentToolGatewayRequest<R>(
                    withAgentToolGatewayRuntimeIdentity(
                      {
                        ...request,
                        ...(operation.request.signal ? { signal: operation.request.signal } : {}),
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
                        ...(owner.executionIdentityToken
                          ? { executionIdentity: owner.executionIdentityToken }
                          : {}),
                        ...(sessionSpawnContext ? { sessionSpawnContext } : {}),
                      },
                    ),
                  ),
                );
              };
              assertSource();
              const startedAt = Date.now();
              let request = operation.request;
              let result: AgentToolResult<unknown> | undefined;
              let errorMessage: string | undefined;
              try {
                const outcome = await runBeforeToolCallHook({
                  toolName: request.toolName,
                  params: workerSessionToolArguments(request),
                  toolCallId: request.request.toolCallId,
                  ctx: {
                    agentId: operation.source.agentId,
                    config: getRuntimeConfig(),
                    sessionKey: operation.source.sessionKey,
                    sessionId: operation.source.sessionId,
                    runId: request.identity.runId ?? undefined,
                  },
                  signal: request.signal,
                  approvalMode: "deny",
                });
                const adjusted = outcome.blocked
                  ? undefined
                  : prepareWorkerSessionToolRequest(
                      request,
                      request.toolName,
                      request.request.toolCallId,
                      outcome.params,
                    );
                assertSource();
                if (
                  !params.placements.isWorkerTurnToolAuthorized(
                    operation.source.turnClaim,
                    request.toolName,
                  )
                ) {
                  throw new Error("Worker session tool authority changed");
                }
                if (adjusted) {
                  request = adjusted;
                  result = await run(
                    {
                      assertSource,
                      callGateway,
                      collectExecutionIdentity: owner.executionIdentityToken !== undefined,
                    },
                    request,
                  );
                } else {
                  result = buildBlockedToolResult({
                    reason: outcome.blocked
                      ? outcome.reason
                      : `Tool call blocked because before_tool_call returned invalid ${request.toolName} input.`,
                    deniedReason: outcome.blocked ? outcome.deniedReason : undefined,
                    toolCallId: request.request.toolCallId,
                    runId: request.identity.runId ?? undefined,
                  });
                }
                return result;
              } catch (error) {
                errorMessage = errorResult(error).details.error;
                throw error;
              } finally {
                void runAgentHarnessAfterToolCallHook({
                  toolName: request.toolName,
                  toolCallId: request.request.toolCallId,
                  runId: request.identity.runId ?? undefined,
                  agentId: owner.agentId,
                  sessionKey: owner.sessionKey,
                  sessionId: operation.source.sessionId,
                  startArgs: workerSessionToolArguments(request),
                  result,
                  error: errorMessage,
                  startedAt,
                });
              }
            },
          ),
        ),
    });
  };
}
