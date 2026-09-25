import { isDeepStrictEqual } from "node:util";
import type { WorkerSessionsSpawnParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { InheritedToolPolicySourceCapture } from "../../agents/inherited-tool-policy.schema.js";
import { buildSubagentExecutionSessionSpawnContext } from "../../agents/subagents/spawn/subagent-spawn-execution-identity.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayToolWithCreation,
  type AgentToolGatewayRequestCaller,
  type InProcessGatewayCaller,
  runWithGatewayToolCleanupContext,
  withAgentToolGatewayRuntimeIdentity,
} from "../../agents/tools/in-process-gateway.js";
import { runWithScopedSessionAccess } from "../../agents/tools/scoped-session-access.js";
import { createSessionsSpawnTool } from "../../agents/tools/sessions-spawn-tool.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../../config/agent-limits.js";
import { getRuntimeConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  bindInProcessSessionSendPolicy,
  readInProcessSessionSendPolicy,
} from "../in-process-session-send-policy.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import type { WorkerPlacementDispatchContract } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  createWorkerPortalToolExecutor,
  type WorkerPortalToolExecutorDependencies,
} from "./worker-portal-tool-executor.js";
import {
  computeRequestDigest,
  workerSessionOperationKey,
  childSessionKey,
} from "./worker-session-tool-identity.js";
import { applyWorkerSessionToolPolicy } from "./worker-session-tool-policy.js";
import {
  serializeWorkerSessionToolResult as serializeResult,
  workerSessionToolErrorResult as errorResult,
  WorkerSessionToolOutcomeUnknownError,
  type WorkerSessionToolExecutor,
} from "./worker-session-tool-result.js";
import { executeWorkerSessionSend } from "./worker-session-tool-send.js";
import {
  assertWorkerSessionToolChild as assertExactChild,
  resolveWorkerSessionToolSource as exactSource,
  withPreparedWorkerSessionToolRows,
  type WorkerSessionToolRowRead,
  workerSessionRelationKey as relationKey,
  type WorkerSessionToolSource as ExactSource,
} from "./worker-session-tool-topology.js";
import { invokeWorkerSkillAuthoring } from "./worker-skill-authoring.js";

type WorkerSessionToolAuthority = {
  assertSource: () => void;
  captureInheritedToolPolicyForDelegation: InheritedToolPolicySourceCapture;
  collectExecutionIdentity: boolean;
  callGateway: <T = Record<string, unknown>>(
    request: Parameters<AgentToolGatewayRequestCaller>[0],
    sessionSpawnContext?: ReturnType<typeof buildSubagentExecutionSessionSpawnContext>,
  ) => Promise<T>;
};

export function createWorkerSessionToolExecutor(params: {
  resolveGatewayContext: GatewayContextResolver;
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get">;
  dispatchChild: WorkerPlacementDispatchContract["dispatch"];
  portals: WorkerPortalToolExecutorDependencies["portals"];
}): WorkerSessionToolExecutor {
  const inFlight = new Map<string, Promise<string>>();
  const executePortal = createWorkerPortalToolExecutor(params);

  const runWithSource = async <T>(
    operation: {
      source: ExactSource;
      identity: WorkerConnectionIdentity;
      signal?: AbortSignal;
      readEntry: WorkerSessionToolRowRead;
    },
    run: (authority: WorkerSessionToolAuthority) => Promise<T>,
  ): Promise<T> => {
    const capability = getWorkerTurnExecutionIdentityCapability(
      params.placements,
      operation.source.turnClaim,
    );
    if (!capability) {
      throw new Error("Worker source turn has no operational owner");
    }
    return await capability.run((owner) =>
      withGatewayToolCallerIdentity(
        {
          agentId: owner.agentId,
          sessionKey: owner.sessionKey,
          gatewayContextResolver: params.resolveGatewayContext,
          operationalRunInstance: owner.operationalRunInstance,
          approvalAuthority: owner.delegatedAuthority,
          ...(owner.operatorAuthority ? { operatorAuthority: owner.operatorAuthority } : {}),
          executionIdentityToken: owner.executionIdentityToken,
          receiptAuthority: owner.receiptAuthority,
          workerTurnClaim: owner.turnClaim,
          workerTurnExecutionIdentityCapability: capability,
          ...(operation.signal ? { approvalSignals: [operation.signal] } : {}),
        },
        async () => {
          const assertSource = () => {
            operation.signal?.throwIfAborted();
            owner.receiptAuthority();
            const source = exactSource({
              identity: operation.identity,
              placements: params.placements,
              readEntry: operation.readEntry,
            });
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
                  bindInProcessSessionSendPolicy(
                    {
                      ...request,
                      ...(operation.signal ? { signal: operation.signal } : {}),
                    },
                    readInProcessSessionSendPolicy(request),
                  ),
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
          return await run({
            assertSource,
            captureInheritedToolPolicyForDelegation: async () => {
              assertSource();
              if (!owner.captureInheritedToolPolicyForDelegation) {
                throw new Error("Worker source has no prepared delegation policy.");
              }
              const captured = await owner.captureInheritedToolPolicyForDelegation();
              const assertCurrent = () => {
                assertSource();
                captured.assertCurrent();
              };
              assertCurrent();
              return { policy: captured.policy, assertCurrent };
            },
            callGateway,
            collectExecutionIdentity: owner.executionIdentityToken !== undefined,
          });
        },
      ),
    );
  };

  const spawn = async (
    operation: {
      source: ExactSource;
      identity: WorkerConnectionIdentity;
      request: WorkerSessionsSpawnParams;
      operationSeed: string;
      childSessionKey: string;
      signal?: AbortSignal;
    },
    {
      assertSource,
      captureInheritedToolPolicyForDelegation,
      callGateway,
      collectExecutionIdentity,
    }: WorkerSessionToolAuthority,
  ) => {
    const sourceEnvironment = params.environments.get(operation.identity.environmentId);
    if (
      !sourceEnvironment ||
      sourceEnvironment.state !== "attached" ||
      sourceEnvironment.ownerEpoch !== operation.identity.ownerEpoch ||
      !isDeepStrictEqual(sourceEnvironment.attachedSessionIds, [operation.source.sessionId])
    ) {
      throw new Error("Worker source environment changed before child spawn");
    }
    const targetAgentId = normalizeAgentId(operation.request.agentId ?? operation.source.agentId);
    const captured = await captureInheritedToolPolicyForDelegation();
    const savedPolicy = captured.policy;
    const assertSourcePolicy = () => {
      assertSource();
      captured.assertCurrent();
    };
    assertSourcePolicy();
    const gatewayCall: InProcessGatewayCaller = async <T = Record<string, unknown>>(
      method: string,
      requestParams: Record<string, unknown>,
    ): Promise<T> => {
      if (method !== "sessions.create") {
        // Cleanup settles the already-created child even after its source closes.
        return await runWithGatewayToolCleanupContext(
          () => callAgentToolGatewayRequest<T>({ method, params: requestParams, timeoutMs: null }),
          params.resolveGatewayContext,
        );
      }
      assertSourcePolicy();
      const projection = getSessionRowProjection(params.resolveGatewayContext());
      if (!projection) {
        throw new Error("Worker session authority is unavailable.");
      }
      await projection.prepareMembership();
      assertSourcePolicy();
      const projected = projection.sharingTargetState({
        key: operation.childSessionKey,
        agentId: targetAgentId,
      });
      if (projected.status === "pending") {
        throw new Error("Cloud child session row is preparing; retry the operation.");
      }
      let loaded = {
        agentId: targetAgentId,
        canonicalKey: operation.childSessionKey,
        entry: projected.status === "ready" ? projected.target.entry : undefined,
      };
      const readChild = () =>
        withPreparedWorkerSessionToolRows({
          resolveGatewayContext: params.resolveGatewayContext,
          sessionKeys: [operation.childSessionKey],
          assertCurrent: assertSourcePolicy,
          consume: async (readEntry) =>
            readEntry(operation.childSessionKey, { agentId: targetAgentId }),
        });
      let createResponse: Record<string, unknown>;
      let creationAttempted = false;
      if (loaded.entry?.sessionId) {
        const parent =
          relationKey(loaded.entry.parentSessionKey) ?? relationKey(loaded.entry.spawnedBy);
        const parentSessionId = relationKey(loaded.entry.parentSessionId);
        if (
          loaded.canonicalKey !== operation.childSessionKey ||
          parent !== operation.source.sessionKey ||
          parentSessionId !== operation.source.sessionId
        ) {
          throw new Error("Cloud child idempotency key is already owned by another session");
        }
        createResponse = {
          ok: true,
          key: loaded.canonicalKey,
          sessionId: loaded.entry.sessionId,
          entry: loaded.entry,
        };
      } else {
        const { source } = operation;
        const createParams: Record<string, unknown> = {
          ...requestParams,
          ...(source.entry.permissionMode ? { permissionMode: source.entry.permissionMode } : {}),
          key: operation.childSessionKey,
        };
        delete createParams.task;
        creationAttempted = true;
        try {
          createResponse = await callInProcessGatewayToolWithCreation(
            "sessions.create",
            createParams,
            {
              via: "spawn",
              actor: { type: "agent", id: source.agentId },
              requesterSessionKey: source.sessionKey,
              inheritedToolPolicy: { version: 2, policy: savedPolicy },
            },
            {
              resolveGatewayContext: params.resolveGatewayContext,
              sessionMutationCommitGuard: assertSourcePolicy,
              ...(operation.signal ? { signal: operation.signal } : {}),
              timeoutMs: null,
            },
          );
        } catch (error) {
          loaded = await readChild();
          if (!loaded.entry?.sessionId) {
            throw error;
          }
          createResponse = {
            ok: true,
            key: loaded.canonicalKey,
            sessionId: loaded.entry.sessionId,
            entry: loaded.entry,
          };
        }
        loaded = await readChild();
      }
      const childSessionId = loaded.entry?.sessionId;
      if (!childSessionId) {
        const error = new Error("Cloud child session creation did not persist an incarnation");
        throw creationAttempted ? new WorkerSessionToolOutcomeUnknownError(error) : error;
      }
      return withPreparedWorkerSessionToolRows({
        resolveGatewayContext: params.resolveGatewayContext,
        sessionKeys: [operation.childSessionKey],
        assertCurrent: assertSourcePolicy,
        consume: async (readEntry) => {
          const assertChild = () =>
            assertExactChild({
              childSessionKey: operation.childSessionKey,
              childSessionId,
              sourceSessionKey: operation.source.sessionKey,
              sourceSessionId: operation.source.sessionId,
              targetAgentId,
              readEntry,
            });
          try {
            assertChild();
          } catch (error) {
            if (creationAttempted) {
              throw new WorkerSessionToolOutcomeUnknownError(error);
            }
            throw error;
          }
          try {
            const assertActiveChildPlacement = () => {
              const placement = params.placements.get(childSessionId);
              if (
                placement?.state !== "active" ||
                placement.sessionKey !== operation.childSessionKey
              ) {
                throw new Error("Cloud child placement did not become active");
              }
              const environment = params.environments.get(placement.environmentId);
              if (
                environment?.state !== "attached" ||
                environment.ownerEpoch !== placement.activeOwnerEpoch ||
                environment.attachedSessionIds.length !== 1 ||
                environment.attachedSessionIds[0] !== childSessionId ||
                environment.profileId !== sourceEnvironment.profileId ||
                environment.providerId !== sourceEnvironment.providerId ||
                !isDeepStrictEqual(environment.profileSnapshot, sourceEnvironment.profileSnapshot)
              ) {
                throw new Error("Cloud child placement does not match its parent profile");
              }
            };
            const childPlacement = params.placements.get(childSessionId);
            assertSourcePolicy();
            if (childPlacement?.state !== "active") {
              try {
                await params.dispatchChild(
                  {
                    sessionId: childSessionId,
                    sessionKey: operation.childSessionKey,
                    agentId: targetAgentId,
                    profileId: sourceEnvironment.profileId,
                    executionMode: "worker-turn",
                    inheritedProfile: {
                      providerId: sourceEnvironment.providerId,
                      profileSnapshot: sourceEnvironment.profileSnapshot,
                    },
                  },
                  undefined,
                  assertSourcePolicy,
                );
              } catch (error) {
                try {
                  assertActiveChildPlacement();
                } catch {
                  throw new WorkerSessionToolOutcomeUnknownError(error);
                }
              }
            }
            assertActiveChildPlacement();
            assertSourcePolicy();
            assertChild();
            const childRunId = workerSessionOperationKey(operation.operationSeed, "initial-task");
            const config = getRuntimeConfig();
            const sessionSpawnContext = collectExecutionIdentity
              ? buildSubagentExecutionSessionSpawnContext({
                  enabled: true,
                  backend: "subagent",
                  parentAgentId: operation.source.agentId,
                  requesterRef: operation.source.sessionKey,
                  controllerRef: operation.source.sessionKey,
                  depth: (operation.source.entry.spawnDepth ?? 0) + 1,
                  maxDepth:
                    config.agents?.defaults?.subagents?.maxSpawnDepth ??
                    DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
                  targetAgentId,
                  sandbox: "inherit",
                  inheritedToolPolicy: savedPolicy,
                })
              : undefined;
            const run = await runWithScopedSessionAccess({
              cfg: config,
              expectedSessionId: childSessionId,
              targetSessionKey: operation.childSessionKey,
              ...(operation.signal ? { signal: operation.signal } : {}),
              run: async () => {
                let sendResult: Record<string, unknown> | undefined;
                for (let attempt = 0; attempt < 2; attempt += 1) {
                  try {
                    assertSourcePolicy();
                    assertChild();
                    assertActiveChildPlacement();
                    const request = {
                      method: "agent",
                      assertDispatchCurrent: () => {
                        assertSourcePolicy();
                        assertChild();
                        assertActiveChildPlacement();
                      },
                      agentRunTracking: "native_subagent",
                      params: {
                        sessionKey: operation.childSessionKey,
                        sessionId: childSessionId,
                        expectedExistingSessionId: childSessionId,
                        message: operation.request.task,
                        deliver: false,
                        sessionEffects: "visible",
                        // A lost response is replayed with this same downstream key;
                        // the child turn is never started under a fresh identity.
                        idempotencyKey: `worker-session-spawn:${childRunId}`,
                      },
                      ...(operation.signal ? { signal: operation.signal } : {}),
                      timeoutMs: null,
                    } as const;
                    sendResult = await callGateway(request, sessionSpawnContext);
                    break;
                  } catch (error) {
                    if (attempt === 1) {
                      throw new WorkerSessionToolOutcomeUnknownError(error);
                    }
                  }
                }
                if (!sendResult) {
                  throw new WorkerSessionToolOutcomeUnknownError(
                    new Error("Cloud child initial task did not return a result"),
                  );
                }
                return sendResult;
              },
            });
            const runId = typeof run.runId === "string" ? run.runId : undefined;
            return {
              ...createResponse,
              ...run,
              runStarted: Boolean(runId),
              ...(runId ? { runId } : {}),
            } as T;
          } catch (error) {
            throw error instanceof WorkerSessionToolOutcomeUnknownError
              ? error
              : new WorkerSessionToolOutcomeUnknownError(error);
          }
        },
      });
    };
    const tool = createSessionsSpawnTool({
      agentSessionKey: operation.source.sessionKey,
      requesterTurnRunId: operation.identity.runId ?? undefined,
      requesterAgentIdOverride: operation.source.agentId,
      captureInheritedToolPolicyForDelegation: async () => ({
        policy: savedPolicy,
        assertCurrent: assertSourcePolicy,
      }),
      callGateway: gatewayCall,
      expectedParentSessionId: operation.source.sessionId,
      ...(operation.signal ? { signal: operation.signal } : {}),
    });
    return await tool.execute(operation.request.toolCallId, {
      task: operation.request.task,
      ...(operation.request.label ? { label: operation.request.label } : {}),
      ...(operation.request.agentId ? { agentId: operation.request.agentId } : {}),
      ...(operation.request.model ? { model: operation.request.model } : {}),
      ...(operation.request.runTimeoutSeconds === undefined
        ? {}
        : { runTimeoutSeconds: operation.request.runTimeoutSeconds }),
      expectsCompletionMessage: false,
      visible: true,
      worktree: true,
    });
  };

  const executeRequest = async (
    request: Parameters<WorkerSessionToolExecutor>[0],
    readEntry: WorkerSessionToolRowRead,
  ) => {
    const source = exactSource({
      identity: request.identity,
      placements: params.placements,
      readEntry,
    });
    if (request.toolName === "skill_workshop") {
      if (!params.placements.isWorkerTurnToolAuthorized(source.turnClaim, "skill_workshop")) {
        throw new Error("Worker Workshop is not authorized.");
      }
      request.signal?.throwIfAborted();
      const result = await invokeWorkerSkillAuthoring(source.turnClaim, request.request);
      exactSource({ identity: request.identity, placements: params.placements, readEntry });
      request.signal?.throwIfAborted();
      return { resultJson: serializeResult(result) };
    }
    if (request.toolName === "portal") {
      return await executePortal(request, readEntry);
    }
    const requestDigest = computeRequestDigest(
      request.toolName === "sessions_spawn"
        ? {
            toolName: request.toolName,
            sourceSessionId: source.sessionId,
            task: request.request.task,
            label: request.request.label ?? null,
            agentId: request.request.agentId ?? null,
            model: request.request.model ?? null,
            runTimeoutSeconds: request.request.runTimeoutSeconds ?? null,
          }
        : {
            toolName: request.toolName,
            sourceSessionId: source.sessionId,
            sessionKey: request.request.sessionKey,
            message: request.request.message,
            timeoutSeconds: request.request.timeoutSeconds ?? null,
          },
    );
    const started = params.placements.beginWorkerSessionToolOperation({
      claim: source.turnClaim,
      toolName: request.toolName,
      toolCallId: request.request.toolCallId,
      requestDigest,
    });
    if (started.kind === "completed") {
      return { resultJson: started.resultJson };
    }
    if (started.kind === "unknown") {
      return {
        resultJson: serializeResult(
          errorResult(new Error("The prior operation outcome is unknown; it was not replayed")),
        ),
      };
    }
    if (started.kind === "conflict") {
      return {
        resultJson: serializeResult(errorResult(new Error("Worker tool call id was reused"))),
      };
    }
    if (started.kind === "capacity") {
      return {
        resultJson: serializeResult(
          errorResult(new Error("Too many worker session operations are already in progress")),
        ),
      };
    }
    if (started.kind === "unauthorized") {
      throw new Error("Worker session tool authority changed");
    }
    const sourceClaimId = source.turnClaim.claimId;
    const inFlightKey = `${source.sessionId}\0${sourceClaimId}\0${request.request.toolCallId}`;
    if (started.kind === "in-progress") {
      const existing = inFlight.get(inFlightKey);
      return {
        resultJson:
          (existing ? await existing : undefined) ??
          serializeResult(
            errorResult(new Error("Worker session operation is already in progress")),
          ),
      };
    }
    const completeOperation = (result: unknown, failed = false) => {
      const resultJson = serializeResult(result);
      return params.placements.completeWorkerSessionToolOperation({
        sourceSessionId: source.sessionId,
        sourceClaimId,
        toolCallId: request.request.toolCallId,
        requestDigest,
        resultJson,
        failed,
      })
        ? resultJson
        : serializeResult(errorResult(new Error("Worker session operation lost ownership")));
    };
    const operation = (async () => {
      let operationRequest = request;
      let result: unknown;
      let failed = false;
      try {
        // Only the elected durable owner runs policy; retries reuse its terminal result.
        result = await runWithSource(
          { source, identity: request.identity, signal: request.signal, readEntry },
          async (authority) => {
            const policy = await applyWorkerSessionToolPolicy({ request, source });
            authority.assertSource();
            if ("result" in policy) {
              return policy.result;
            }
            operationRequest = policy.request;
            let childKey = started.childSessionKey;
            if (operationRequest.toolName === "sessions_spawn" && !childKey) {
              const targetAgentId = normalizeAgentId(
                operationRequest.request.agentId ?? source.agentId,
              );
              childKey = childSessionKey(started.operationSeed, targetAgentId);
              if (
                !params.placements.bindWorkerSessionToolOperationChild({
                  sourceSessionId: source.sessionId,
                  sourceClaimId,
                  toolCallId: operationRequest.request.toolCallId,
                  requestDigest,
                  childSessionKey: childKey,
                })
              ) {
                throw new Error("Worker child spawn operation changed before execution");
              }
            }
            return operationRequest.toolName === "sessions_spawn"
              ? await spawn(
                  {
                    source,
                    identity: operationRequest.identity,
                    request: operationRequest.request,
                    operationSeed: started.operationSeed,
                    childSessionKey: childKey!,
                    ...(operationRequest.signal ? { signal: operationRequest.signal } : {}),
                  },
                  authority,
                )
              : await executeWorkerSessionSend({
                  assertSource: authority.assertSource,
                  captureInheritedToolPolicyForDelegation:
                    authority.captureInheritedToolPolicyForDelegation,
                  callGateway: authority.callGateway,
                  source,
                  resolveGatewayContext: params.resolveGatewayContext,
                  readSourceEntry: readEntry,
                  request: operationRequest.request,
                  idempotencyKey: `worker-session-send:${workerSessionOperationKey(
                    started.operationSeed,
                    "target-send",
                  )}`,
                  ...(operationRequest.signal ? { signal: operationRequest.signal } : {}),
                });
          },
        );
      } catch (error) {
        if (
          error instanceof WorkerSessionToolOutcomeUnknownError ||
          operationRequest.signal?.aborted
        ) {
          if (
            !params.placements.abandonWorkerSessionToolOperation({
              sourceSessionId: source.sessionId,
              sourceClaimId,
              toolCallId: operationRequest.request.toolCallId,
              requestDigest,
            })
          ) {
            return serializeResult(
              errorResult(new Error("Worker session operation lost ownership")),
            );
          }
          return serializeResult(
            errorResult(
              error instanceof WorkerSessionToolOutcomeUnknownError
                ? error
                : new Error("Worker session operation outcome is unknown after cancellation"),
            ),
          );
        }
        failed = true;
        result = errorResult(error);
      }
      return completeOperation(result, failed);
    })();
    inFlight.set(inFlightKey, operation);
    try {
      return { resultJson: await operation };
    } finally {
      if (inFlight.get(inFlightKey) === operation) {
        inFlight.delete(inFlightKey);
      }
    }
  };
  return async (request) => {
    const placement = request.identity.sessionId
      ? params.placements.get(request.identity.sessionId)
      : undefined;
    if (!placement) {
      throw new Error("Worker source session placement changed");
    }
    return withPreparedWorkerSessionToolRows({
      resolveGatewayContext: params.resolveGatewayContext,
      sessionKeys: [placement.sessionKey],
      assertCurrent: () => request.signal?.throwIfAborted(),
      consume: (readEntry) => executeRequest(request, readEntry),
    });
  };
}
