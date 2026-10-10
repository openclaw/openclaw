import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString as relationKey } from "@openclaw/normalization-core/string-coerce";
import {
  bindAgentToolExecutionLocation,
  copyAgentToolMetadata,
  getAgentToolExecutionLocation,
} from "../../agents/agent-tool-metadata.js";
import { buildBlockedToolResult } from "../../agents/agent-tools.before-tool-call.wrapper.js";
import { selectDelegatedToolPolicy } from "../../agents/delegated-tool-policy.js";
import { resolveSenderRestrictedSpawnError } from "../../agents/spawn-requester-policy.js";
import { buildSubagentExecutionSessionSpawnContext } from "../../agents/subagents/spawn/subagent-spawn-execution-identity.js";
import { jsonResult, type AnyAgentTool } from "../../agents/tools/common.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayToolWithCreation,
  type InProcessGatewayCaller,
  runWithGatewayToolCleanupContext,
} from "../../agents/tools/in-process-gateway.js";
import { createAvailablePortalTools } from "../../agents/tools/portal-tool.js";
import { PRESENCE_QUERY_TIMEOUT_MS } from "../../agents/tools/presence-tool-contract.js";
import { createPresenceTool } from "../../agents/tools/presence-tool.js";
import { runWithScopedSessionAccess } from "../../agents/tools/scoped-session-access.js";
import type { PlacedSessionsSpawnArguments } from "../../agents/tools/sessions-placement-tool-contract.js";
import { createSessionsSendTool } from "../../agents/tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "../../agents/tools/sessions-spawn-tool.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../../config/agent-limits.js";
import { getRuntimeConfig } from "../../config/config.js";
import { sha256Base64Url, sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import {
  getWorkerTurnExecutionIdentityCapability,
  getWorkerTurnToolSurface,
} from "./placement-turn-claim-events.js";
import type { WorkerPlacementDispatchContract } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  createWorkerPortalToolExecutor,
  type WorkerPortalToolExecutorDependencies,
} from "./worker-portal-tool-executor.js";
import {
  serializeWorkerSessionToolError as serializeError,
  executeWorkerSessionToolWithReplay,
  serializeWorkerSessionToolResult as serializeResult,
  workerSessionToolErrorResult as errorResult,
  WorkerSessionToolOutcomeUnknownError,
  type WorkerSessionToolExecutor,
  type WorkerSessionToolRequest,
  parseWorkerSessionToolResult,
} from "./worker-session-tool-result.js";
import { executeWorkerSessionSend } from "./worker-session-tool-send.js";
import {
  createWorkerSessionToolSourceRunner,
  prepareWorkerSessionToolRequest,
  type WorkerSessionToolAuthority,
} from "./worker-session-tool-source.js";
import {
  assertWorkerSessionToolChild as assertExactChild,
  readWorkerSessionToolEntry,
  resolveWorkerSessionToolSource as exactSource,
  resolveWorkerSessionToolTarget as exactAuthorizedTarget,
  type WorkerSessionToolSource as ExactSource,
} from "./worker-session-tool-topology.js";

function operationKey(operationSeed: string, purpose: string): string {
  return sha256Base64Url(`openclaw.worker-session-tool-operation.v1\0${operationSeed}\0${purpose}`);
}

type WorkerGatewayToolsDependencies = {
  resolveGatewayContext: GatewayContextResolver;
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get">;
  dispatchChild: WorkerPlacementDispatchContract["dispatch"];
  portals: WorkerPortalToolExecutorDependencies["portals"];
  skillWorkshop?: AnyAgentTool;
  portalAvailable?: boolean;
  inheritedToolPolicySource?: "sender";
  inheritedToolDenylist?: string[];
  delegatedToolPolicyActive?: boolean;
  prepareTools?: (adapters: AnyAgentTool[]) => AnyAgentTool[] | Promise<AnyAgentTool[]>;
};

export function createWorkerSessionToolExecutor(
  params: WorkerGatewayToolsDependencies,
  definitions: Record<WorkerSessionToolRequest["toolName"], AnyAgentTool>,
): WorkerSessionToolExecutor {
  const inFlight = new Map<string, Promise<string>>();
  const executePortal = createWorkerPortalToolExecutor(params);

  const runWithSource = createWorkerSessionToolSourceRunner(params);
  const runTool = (
    source: ExactSource,
    request: WorkerSessionToolRequest,
    execute: (
      authority: WorkerSessionToolAuthority,
      request: WorkerSessionToolRequest,
    ) => ReturnType<AnyAgentTool["execute"]>,
  ) => {
    const { toolCallId, ...args } = request.request;
    return runWithSource({
      source,
      request: {
        ...request,
        approvalMode: "deny",
        request: { toolCallId, arguments: args },
        tool: (authority) =>
          copyAgentToolMetadata(definitions[request.toolName], {
            ...definitions[request.toolName],
            execute: (id, raw, signal, onUpdate) => {
              const prepared = prepareWorkerSessionToolRequest(
                { ...request, signal, onUpdate },
                request.toolName,
                id,
                raw,
              );
              if (!prepared) {
                return Promise.resolve(
                  buildBlockedToolResult({
                    reason: `Tool call blocked because before_tool_call returned invalid ${request.toolName} input.`,
                    toolCallId: id,
                    runId: request.identity.runId ?? undefined,
                  }),
                );
              }
              return execute(authority, prepared);
            },
          }),
      },
    });
  };

  const spawn = async (
    operation: {
      source: ExactSource;
      identity: WorkerConnectionIdentity;
      request: PlacedSessionsSpawnArguments & { toolCallId: string };
      operationSeed: string;
      childSessionKey: string;
      signal?: AbortSignal;
    },
    { assertSource, callGateway, collectExecutionIdentity }: WorkerSessionToolAuthority,
  ) => {
    if (params.delegatedToolPolicyActive) {
      return jsonResult({
        status: "forbidden",
        error:
          "Worker-originated child spawning cannot preserve this delegated execution grant. Start the helper from a Gateway-side native session.",
      });
    }
    const restrictedError = resolveSenderRestrictedSpawnError({
      inheritedToolPolicySource: params.inheritedToolPolicySource,
      visible: true,
    });
    if (restrictedError) {
      return jsonResult({ status: "forbidden", error: restrictedError });
    }
    const targetAgentId = normalizeAgentId(operation.request.agentId ?? operation.source.agentId);
    // Workers export their final catalog, not a separated requester-local deny floor.
    // Apply the same explicit-grant refusal as other unsupported native producers.
    selectDelegatedToolPolicy({
      config: getRuntimeConfig(),
      requesterSessionKey: operation.source.sessionKey,
      requesterAgentId: operation.source.agentId,
      targetAgentId,
      inheritedToolPolicySource: params.inheritedToolPolicySource,
    });
    const sourceEnvironment = params.environments.get(operation.identity.environmentId);
    if (
      !sourceEnvironment ||
      sourceEnvironment.state !== "attached" ||
      sourceEnvironment.ownerEpoch !== operation.identity.ownerEpoch ||
      !isDeepStrictEqual(sourceEnvironment.attachedSessionIds, [operation.source.sessionId])
    ) {
      throw new Error("Worker source environment changed before child spawn");
    }
    const surface = await getWorkerTurnToolSurface(operation.identity)?.getSurface(
      operation.identity,
    );
    assertSource();
    if (!surface) {
      throw new Error("Worker tool surface is unavailable");
    }
    const authorizedTools = surface.tools
      .map((tool) => tool.definition.name)
      .filter((name) =>
        params.placements.isWorkerTurnToolAuthorized(operation.source.turnClaim, name),
      );
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
      assertSource();
      let loaded = await readWorkerSessionToolEntry(operation.childSessionKey, targetAgentId);
      let createResponse: Record<string, unknown> | undefined;
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
              inheritedToolPolicy: {
                version: 1,
                allow: authorizedTools,
                deny: [...(params.inheritedToolDenylist ?? [])],
              },
            },
            {
              resolveGatewayContext: params.resolveGatewayContext,
              sessionMutationCommitGuard: assertSource,
              ...(operation.signal ? { signal: operation.signal } : {}),
              timeoutMs: null,
            },
          );
        } catch (error) {
          loaded = await readWorkerSessionToolEntry(operation.childSessionKey, targetAgentId);
          if (!loaded.entry?.sessionId) {
            throw error;
          }
        }
        loaded = await readWorkerSessionToolEntry(operation.childSessionKey, targetAgentId);
      }
      const childSessionId = loaded.entry?.sessionId;
      if (!childSessionId) {
        const error = new Error("Cloud child session creation did not persist an incarnation");
        throw creationAttempted ? new WorkerSessionToolOutcomeUnknownError(error) : error;
      }
      const assertChild = () =>
        assertExactChild({
          childSessionKey: operation.childSessionKey,
          childSessionId,
          sourceSessionKey: operation.source.sessionKey,
          sourceSessionId: operation.source.sessionId,
          targetAgentId,
          storePath: loaded.storePath,
        });
      try {
        await assertChild();
      } catch (error) {
        if (creationAttempted) {
          throw new WorkerSessionToolOutcomeUnknownError(error);
        }
        throw error;
      }
      try {
        const config = getRuntimeConfig();
        return await runWithScopedSessionAccess({
          cfg: config,
          agentId: targetAgentId,
          storePath: loaded.storePath,
          expectedSessionId: childSessionId,
          targetSessionKey: operation.childSessionKey,
          ...(operation.signal ? { signal: operation.signal } : {}),
          run: async () => {
            await assertChild();
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
            const childPlacement = await params.placements.getAsync(childSessionId);
            assertSource();
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
                  assertSource,
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
            assertSource();
            await assertChild();
            const childRunId = operationKey(operation.operationSeed, "initial-task");
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
                  inheritedToolAllowlist: authorizedTools,
                  inheritedToolDenylist: params.inheritedToolDenylist,
                })
              : undefined;
            const run = await executeWorkerSessionToolWithReplay(async () => {
              assertSource();
              await assertChild();
              assertSource();
              assertActiveChildPlacement();
              return callGateway(
                {
                  method: "agent",
                  agentRunTracking: "native_subagent",
                  params: {
                    sessionKey: operation.childSessionKey,
                    sessionId: childSessionId,
                    expectedExistingSessionId: childSessionId,
                    message: operation.request.task,
                    deliver: false,
                    sessionEffects: "visible",
                    idempotencyKey: `worker-session-spawn:${childRunId}`,
                  },
                  ...(operation.signal ? { signal: operation.signal } : {}),
                  timeoutMs: null,
                },
                sessionSpawnContext,
              );
            });
            const runId = typeof run.runId === "string" ? run.runId : undefined;
            return {
              ...(createResponse ?? {
                ok: true,
                key: loaded.canonicalKey,
                sessionId: childSessionId,
                entry: loaded.entry,
              }),
              ...run,
              runStarted: Boolean(runId),
              ...(runId ? { runId } : {}),
            } as T;
          },
        });
      } catch (error) {
        throw error instanceof WorkerSessionToolOutcomeUnknownError
          ? error
          : new WorkerSessionToolOutcomeUnknownError(error);
      }
    };
    const tool = createSessionsSpawnTool({
      agentSessionKey: operation.source.sessionKey,
      requesterTurnRunId: operation.identity.runId ?? undefined,
      requesterAgentIdOverride: operation.source.agentId,
      inheritedToolAllowlist: authorizedTools,
      inheritedToolDenylist: params.inheritedToolDenylist,
      inheritedToolPolicySource: params.inheritedToolPolicySource,
      callGateway: gatewayCall,
      expectedParentSessionId: operation.source.sessionId,
      ...(operation.signal ? { signal: operation.signal } : {}),
    });
    const { toolCallId, ...args } = operation.request;
    return await tool.execute(toolCallId, {
      ...args,
      expectsCompletionMessage: false,
      visible: true,
      worktree: true,
    });
  };

  return async (request) => {
    const source = await exactSource({ identity: request.identity, placements: params.placements });
    if (request.toolName === "portal") {
      return await runTool(source, request, async (authority, prepared) => {
        if (prepared.toolName !== "portal") {
          throw new Error("Worker tool policy changed the tool identity");
        }
        return executePortal(prepared, source, authority.assertSource);
      });
    }
    const requestDigest = sha256Base64Url(
      `openclaw.worker-session-tool-request.v1\0${JSON.stringify({
        toolName: request.toolName,
        sourceSessionId: source.sessionId,
        ...(request.toolName === "sessions_spawn"
          ? {
              task: request.request.task,
              label: request.request.label ?? null,
              agentId: request.request.agentId ?? null,
              model: request.request.model ?? null,
              runTimeoutSeconds: request.request.runTimeoutSeconds ?? null,
            }
          : {
              sessionKey: request.request.sessionKey,
              message: request.request.message,
              timeoutSeconds: request.request.timeoutSeconds ?? null,
            }),
      })}`,
    );
    const started = await params.placements.beginWorkerSessionToolOperation(
      {
        claim: source.turnClaim,
        toolName: request.toolName,
        toolCallId: request.request.toolCallId,
        requestDigest,
      },
      () => {
        request.signal?.throwIfAborted();
        if (!params.placements.isWorkerTurnToolAuthorized(source.turnClaim, request.toolName)) {
          throw new Error("Worker session tool authority changed");
        }
      },
    );
    if (started.kind === "completed") {
      return parseWorkerSessionToolResult(started.resultJson);
    }
    if (started.kind === "unknown" || started.kind === "conflict" || started.kind === "capacity") {
      const message = {
        unknown: "The prior operation outcome is unknown; it was not replayed",
        conflict: "Worker tool call id was reused",
        capacity: "Too many worker session operations are already in progress",
      }[started.kind];
      return errorResult(new Error(message));
    }
    if (started.kind === "unauthorized") {
      throw new Error("Worker session tool authority changed");
    }
    const sourceClaimId = source.turnClaim.claimId;
    const operationIdentity = {
      sourceSessionId: source.sessionId,
      sourceClaimId,
      toolCallId: request.request.toolCallId,
      requestDigest,
    };
    const inFlightKey = `${source.sessionId}\0${sourceClaimId}\0${request.request.toolCallId}`;
    if (started.kind === "in-progress") {
      const existing = inFlight.get(inFlightKey);
      return existing
        ? parseWorkerSessionToolResult(await existing)
        : errorResult(new Error("Worker session operation is already in progress"));
    }
    const operation = (async () => {
      let result: unknown;
      let failed = false;
      try {
        // Only the elected durable owner runs policy; retries reuse its terminal result.
        result = await runTool(source, request, async (authority, prepared) => {
          if (prepared.toolName !== "sessions_spawn" && prepared.toolName !== "sessions_send") {
            throw new Error("Worker tool policy changed the tool identity");
          }
          if (prepared.toolName === "sessions_spawn") {
            const targetAgentId = normalizeAgentId(prepared.request.agentId ?? source.agentId);
            const childKey = `agent:${targetAgentId}:dashboard:cloud-${sha256HexPrefixCore(
              `openclaw.worker-session-tool-operation.v1\0${started.operationSeed}\0child-session`,
              32,
            )}`;
            if (
              !(await params.placements.bindWorkerSessionToolOperationChild({
                ...operationIdentity,
                childSessionKey: childKey,
              }))
            ) {
              throw new Error("Worker child spawn operation changed before execution");
            }
            return await spawn(
              {
                source,
                identity: prepared.identity,
                request: prepared.request,
                operationSeed: started.operationSeed,
                childSessionKey: childKey,
                signal: prepared.signal,
              },
              authority,
            );
          }
          return await executeWorkerSessionSend({
            assertSource: authority.assertSource,
            callGateway: authority.callGateway,
            source,
            target: await exactAuthorizedTarget({
              source,
              requestedSessionKey: prepared.request.sessionKey,
            }),
            request: prepared.request,
            idempotencyKey: `worker-session-send:${operationKey(started.operationSeed, "target-send")}`,
            signal: prepared.signal,
          });
        });
      } catch (error) {
        if (error instanceof WorkerSessionToolOutcomeUnknownError || request.signal?.aborted) {
          if (!(await params.placements.abandonWorkerSessionToolOperation(operationIdentity))) {
            return serializeError(new Error("Worker session operation lost ownership"));
          }
          return serializeError(
            error instanceof WorkerSessionToolOutcomeUnknownError
              ? error
              : new Error("Worker session operation outcome is unknown after cancellation"),
          );
        }
        failed = true;
        result = errorResult(error);
      }
      const resultJson = serializeResult(result);
      return (await params.placements.completeWorkerSessionToolOperation({
        ...operationIdentity,
        resultJson,
        failed,
      }))
        ? resultJson
        : serializeError(new Error("Worker session operation lost ownership"));
    })();
    inFlight.set(inFlightKey, operation);
    try {
      return parseWorkerSessionToolResult(await operation);
    } finally {
      inFlight.delete(inFlightKey);
    }
  };
}

export function createWorkerWorkshopCallRetention() {
  const calls = new Map<string, { digest: string; result: ReturnType<AnyAgentTool["execute"]> }>();
  return (
    toolCallId: string,
    args: unknown,
    execute: () => ReturnType<AnyAgentTool["execute"]>,
  ) => {
    const digest = JSON.stringify(args);
    const prior = calls.get(toolCallId);
    if (prior && prior.digest !== digest) {
      throw new Error("Workshop tool call id was reused with different arguments.");
    }
    if (!prior && calls.size >= 64) {
      throw new Error("This turn reached its Workshop operation limit. Continue in a fresh turn.");
    }
    const result = prior?.result ?? execute();
    calls.set(toolCallId, { digest, result });
    return result;
  };
}

export async function createWorkerGatewayTools(
  params: WorkerGatewayToolsDependencies & { identity: WorkerConnectionIdentity },
): Promise<AnyAgentTool[]> {
  const claim = params.identity.turnClaim;
  const capability = claim && getWorkerTurnExecutionIdentityCapability(params.placements, claim);
  if (!claim || !capability) {
    throw new Error("Worker source turn has no operational owner");
  }
  const source = capability.sessionTarget;
  const toolOptions = { agentSessionKey: source.sessionKey, workerPlacement: true };
  const portal = createAvailablePortalTools({
    sessionPortalTarget: {
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      environmentId: params.identity.environmentId,
      assertCurrent: capability.receiptAuthority,
    },
  })[0]!;
  const presence = createPresenceTool({
    assertSourceCurrent: capability.assertPresenceSourceCurrent,
  });
  bindAgentToolExecutionLocation(presence, {
    kind: "gateway",
    connectionScoped: true,
    timeout: { minimumMs: PRESENCE_QUERY_TIMEOUT_MS },
  });
  const assertAuthorized = (name: string) => {
    capability.receiptAuthority();
    if (!params.placements.isWorkerTurnToolAuthorized(claim, name)) {
      throw new Error("Worker tool authority changed");
    }
  };
  const definitions = {
    sessions_spawn: createSessionsSpawnTool(toolOptions),
    sessions_send: createSessionsSendTool(toolOptions),
    portal,
  };
  const execute = createWorkerSessionToolExecutor(params, definitions);
  const adapters = Object.values(definitions).map((tool) => {
    const bound = copyAgentToolMetadata<AnyAgentTool>(tool, {
      ...tool,
      execute: async (toolCallId, raw, signal, onUpdate) => {
        assertAuthorized(tool.name);
        const operation = prepareWorkerSessionToolRequest(
          { identity: params.identity, signal, onUpdate },
          tool.name,
          toolCallId,
          raw,
        );
        if (!operation) {
          throw new Error(`Invalid ${tool.name} arguments`);
        }
        const value = await execute(operation);
        assertAuthorized(tool.name);
        return value;
      },
    });
    bindAgentToolExecutionLocation(bound, {
      kind: "gateway",
      ...(tool.name === "portal" && params.portalAvailable === false
        ? { unavailableReason: "this placement has no portal transport" }
        : {}),
      replay: tool.name === "sessions_spawn" || tool.name === "sessions_send",
      ...(tool.name === "sessions_spawn"
        ? { timeout: { minimumMs: 900_000 } }
        : tool.name === "sessions_send"
          ? { timeout: { argument: "timeoutSeconds", defaultSeconds: 30, paddingMs: 60_000 } }
          : {}),
    });
    return bound;
  });
  const adapterNames = new Set(adapters.map((tool) => tool.name));
  const runWithSource = createWorkerSessionToolSourceRunner(params);
  const retainWorkshopCall = createWorkerWorkshopCallRetention();
  const tools = [...adapters, presence, ...(params.skillWorkshop ? [params.skillWorkshop] : [])];
  const preparedTools = await (params.prepareTools?.(tools) ?? tools);
  capability.receiptAuthority();
  return preparedTools.map((tool) => {
    if (getAgentToolExecutionLocation(tool).kind === "placement" || adapterNames.has(tool.name)) {
      return tool;
    }
    return copyAgentToolMetadata(tool, {
      ...tool,
      execute: async (toolCallId, args, signal, onUpdate) => {
        assertAuthorized(tool.name);
        const invoke = () =>
          runWithSource({
            source: { ...source, turnClaim: claim },
            request: {
              tool,
              toolName: tool.name,
              ...(tool.name === "presence" || tool.name === "skill_workshop"
                ? { approvalMode: "deny" as const }
                : {}),
              identity: params.identity,
              signal,
              onUpdate,
              request: { toolCallId, arguments: args },
            },
          });
        const result = await (tool.name === "skill_workshop"
          ? retainWorkshopCall(toolCallId, args, invoke)
          : invoke());
        assertAuthorized(tool.name);
        return result;
      },
    });
  });
}
