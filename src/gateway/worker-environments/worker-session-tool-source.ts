import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import type { AnyAgentTool } from "../../agents/tools/common.js";
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
import type { WorkerSessionPlacementStore, WorkerSessionTurnClaim } from "./placement-store.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import {
  workerSessionToolErrorResult as errorResult,
  type WorkerSessionToolRequest,
} from "./worker-session-tool-result.js";
import type { WorkerSessionToolSource as ExactSource } from "./worker-session-tool-topology.js";

type GenericWorkerToolRequest = Pick<
  WorkerSessionToolRequest,
  "identity" | "signal" | "onUpdate"
> & {
  toolName: string;
  tool: AnyAgentTool;
  request: { toolCallId: string; arguments: unknown };
};
type WorkerToolRequest = WorkerSessionToolRequest | GenericWorkerToolRequest;

export function workerSessionToolArguments(request: WorkerToolRequest): Record<string, unknown> {
  if ("tool" in request || request.toolName === "skill_workshop") {
    const args = request.request.arguments;
    if (!isRecord(args)) {
      throw new Error("Worker tool arguments must be an object");
    }
    return args;
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
    operation: {
      source: Pick<ExactSource, "agentId" | "sessionId" | "sessionKey"> & {
        turnClaim: WorkerSessionTurnClaim;
      };
    } & (
      | { request: GenericWorkerToolRequest }
      | {
          request: WorkerSessionToolRequest;
          execute: (
            authority: WorkerSessionToolAuthority,
            request: WorkerSessionToolRequest,
          ) => Promise<AgentToolResult<unknown>>;
        }
    ),
  ): Promise<AgentToolResult<unknown>> => {
    const capability = getWorkerTurnExecutionIdentityCapability(
      params.placements,
      operation.source.turnClaim,
    );
    if (!capability) {
      throw new Error("Worker source turn has no operational owner");
    }
    const assertToolCurrent = () => {
      capability.receiptAuthority();
      operation.request.signal?.throwIfAborted();
      if (
        !params.placements.isWorkerTurnToolAuthorized(
          operation.source.turnClaim,
          operation.request.toolName,
        )
      ) {
        throw new Error("Worker session tool authority changed");
      }
    };
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
              const assertPresenceSourceCurrent =
                operation.request.toolName === "presence"
                  ? (owner.assertPresenceSourceCurrent ?? capturePresenceToolAuthority())
                  : undefined;
              const assertSource = () => {
                assertToolCurrent();
                assertPresenceSourceCurrent?.();
                const source = operation.source;
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
                if (!("execute" in operation)) {
                  const generic = operation.request;
                  result = await generic.tool.execute(
                    generic.request.toolCallId,
                    generic.request.arguments,
                    generic.signal,
                    generic.onUpdate,
                  );
                  assertSource();
                  return result;
                }
                request = operation.request;
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
                if (adjusted) {
                  request = adjusted;
                  result = await operation.execute(
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
