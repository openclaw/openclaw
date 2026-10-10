import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { bindAgentToolSourceExecutionGuard } from "../../agents/agent-tool-source-execution-guard.js";
import { rewrapToolWithBeforeToolCallHook } from "../../agents/agent-tools.before-tool-call.wrapper.js";
import { runWithToolExecutionValidation } from "../../agents/agent-tools.execution-validation.js";
import { getBeforeToolCallHookContext } from "../../agents/before-tool-call-metadata.js";
import { runAgentHarnessAfterToolCallHook } from "../../agents/harness/hook-helpers.js";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { buildSubagentExecutionSessionSpawnContext } from "../../agents/subagents/spawn/subagent-spawn-execution-identity.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
  withAgentToolGatewayRuntimeIdentity,
} from "../../agents/tools/in-process-gateway.js";
import { SessionPortalToolSchema } from "../../agents/tools/portal-tool-contract.js";
import { runWithScopedSessionAccess } from "../../agents/tools/scoped-session-access.js";
import {
  PlacedSessionsSpawnSchema,
  PlacedSessionsSendSchema,
} from "../../agents/tools/sessions-placement-tool-contract.js";
import { getRuntimeConfig } from "../../config/config.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { WorkerSessionPlacementStore, WorkerSessionTurnClaim } from "./placement-store.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import {
  workerSessionToolErrorResult as errorResult,
  type WorkerSessionToolRequest,
} from "./worker-session-tool-result.js";
import type { WorkerSessionToolSource as ExactSource } from "./worker-session-tool-topology.js";

type WorkerToolRequest = Pick<WorkerSessionToolRequest, "identity" | "signal" | "onUpdate"> & {
  toolName: string;
  tool: AnyAgentTool | ((authority: WorkerSessionToolAuthority) => AnyAgentTool);
  approvalMode?: "deny";
  request: { toolCallId: string; arguments: unknown };
};

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
  return async (operation: {
    source: Pick<ExactSource, "agentId" | "sessionId" | "sessionKey"> & {
      turnClaim: WorkerSessionTurnClaim;
    };
    request: WorkerToolRequest;
  }): Promise<AgentToolResult<unknown>> => {
    const startArgs = operation.request.request.arguments;
    if (!isRecord(startArgs)) {
      throw new Error("Worker tool arguments must be an object");
    }
    const capability = getWorkerTurnExecutionIdentityCapability(
      params.placements,
      operation.source.turnClaim,
    );
    if (!capability) {
      throw new Error("Worker source turn has no operational owner");
    }
    const assertToolCurrent = composeSessionSourceAssertion(
      [capability.receiptAuthority],
      (assertSource) => {
        assertSource();
        operation.request.signal?.throwIfAborted();
        if (
          !params.placements.isWorkerTurnToolAuthorized(
            operation.source.turnClaim,
            operation.request.toolName,
          )
        ) {
          throw new Error("Worker tool authority changed");
        }
      },
    );
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
              receiptAuthority: assertToolCurrent,
              workerTurnClaim: owner.turnClaim,
              workerTurnExecutionIdentityCapability: capability,
              ...(operation.request.signal ? { approvalSignals: [operation.request.signal] } : {}),
            },
            async () => {
              const assertSource = composeSessionSourceAssertion(
                [assertToolCurrent],
                (assertCurrent) => {
                  assertCurrent();
                  const source = operation.source;
                  if (source.agentId !== owner.agentId || source.sessionKey !== owner.sessionKey) {
                    throw new Error("Worker source turn owner changed");
                  }
                },
              );
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
                        executionIdentity: owner.executionIdentityToken,
                        sessionSpawnContext,
                      },
                    ),
                  ),
                );
              };
              assertSource();
              const startedAt = Date.now();
              const request = operation.request;
              let result: AgentToolResult<unknown> | undefined;
              let errorMessage: string | undefined;
              try {
                const sourceTool =
                  typeof request.tool === "function"
                    ? request.tool({
                        assertSource,
                        callGateway,
                        collectExecutionIdentity: owner.executionIdentityToken !== undefined,
                      })
                    : request.tool;
                const tool = rewrapToolWithBeforeToolCallHook(
                  bindAgentToolSourceExecutionGuard(sourceTool, assertSource),
                  getBeforeToolCallHookContext(sourceTool) ?? {
                    ...operation.source,
                    config: getRuntimeConfig(),
                    runId: request.identity.runId ?? undefined,
                  },
                  request.approvalMode ? { approvalMode: request.approvalMode } : {},
                );
                result = await runWithToolExecutionValidation(
                  request.request.toolCallId,
                  (args) => {
                    // Bound adapters validate and narrow rewrites at their protocol owner.
                    if (typeof request.tool !== "function" && !Value.Check(tool.parameters, args)) {
                      throw new Error(`Invalid ${request.toolName} arguments`);
                    }
                  },
                  () =>
                    tool.execute(
                      request.request.toolCallId,
                      request.request.arguments,
                      request.signal,
                      request.onUpdate,
                    ),
                );
                assertSource();
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
                  startArgs,
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
