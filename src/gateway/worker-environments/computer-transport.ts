import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { ComputerTakeControlParamsSchema } from "../../agents/tools/computer-tool-control.js";
import { isComputerObservationAction } from "../../agents/tools/computer-tool-shared.js";
import type { ComputerToolTransport } from "../../agents/tools/computer-tool.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { NODE_WORKER_DESKTOP_COMPUTER_COMMAND } from "../../infra/node-commands.js";
import { parseComputerUseCapabilityDescriptor } from "../../plugins/computer-use-contract.js";
import { getActivePluginGatewayNodePolicyRegistry } from "../../plugins/runtime-state.js";
import type { WorkerComputerLaunchDescriptor } from "../../worker/launch-descriptor.js";
import { parseNodeWorkerComputerInput } from "../../worker/node-computer-protocol.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { DesktopSessionRegistry } from "../desktop/session-registry.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { applyPluginNodeInvokePolicy } from "../node-invoke-plugin-policy.js";
import { invokeNodeWithReadinessRetry } from "../node-invoke-readiness.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { WorkerSessionPlacementStore, WorkerSessionTurnClaim } from "./placement-store.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
import { WorkerRunnerUnavailableError } from "./tunnel-contract.js";

const COMPUTER_COMMANDS = ["screen.snapshot", "computer.act"] as const;

type InvokeResult = Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>;

function payload(result: InvokeResult): unknown {
  if (!result.ok) {
    throw new Error(result.error?.message ?? "Session desktop command failed");
  }
  return result.payloadJSON ? JSON.parse(result.payloadJSON) : result.payload;
}

type WorkerComputerTransport = Omit<ComputerToolTransport, "invoke"> & {
  invoke(
    request: Parameters<ComputerToolTransport["invoke"]>[0],
    assertAuthorized?: () => void,
  ): Promise<unknown>;
};

export type PreparedWorkerComputer = {
  descriptor: WorkerComputerLaunchDescriptor;
  bind(
    operationalRunInstance: OperationalRunInstanceRef,
    workerSource?: { authority: AgentRunDelegatedAuthority; assertCurrent: () => void },
  ): WorkerComputerTransport;
  close(reason: string): Promise<void>;
};

export type WorkerEnvironmentComputerAuthority = {
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  runId: string;
  assertCurrent(): void;
  turnClaim?: WorkerSessionTurnClaim;
};

type WorkerComputerOwnerOptions = {
  store: Pick<WorkerEnvironmentStore, "get">;
  resolveGatewayContext: GatewayContextResolver;
  getNodeTransport: () => NodeWorkerSupervisorTransport | undefined;
  desktopRegistry?: Pick<
    DesktopSessionRegistry,
    "hasController" | "onControlChanged" | "takeControl"
  >;
  warn: (message: string) => void;
};

/** Captures one environment's desktop under its placement or conversation attachment owner. */
export function createEnvironmentComputerTransportOwner(options: WorkerComputerOwnerOptions) {
  // Retries can rebuild bindings and attachment preparations within one admitted run.
  const takeoversByRun = new WeakMap<AgentRunDelegatedAuthority, Set<string>>();
  return async (
    source: WorkerEnvironmentComputerAuthority,
  ): Promise<PreparedWorkerComputer | undefined> => {
    source.assertCurrent();
    const environment = options.store.get(source.environmentId);
    if (!environment?.nodeDeviceId || (!environment.desktop && !environment.sharedHost)) {
      return undefined;
    }
    const context = options.resolveGatewayContext();
    const nodeTransport = options.getNodeTransport();
    if (!context || !nodeTransport) {
      throw new Error("Session desktop Gateway is unavailable");
    }
    const node = context.nodeRegistry.get(environment.nodeDeviceId);
    if (!node) {
      throw new WorkerRunnerUnavailableError();
    }
    const environmentIsCurrent = (current: WorkerEnvironmentRecord | undefined) => {
      const currentNode = context.nodeRegistry.get(node.nodeId);
      return (
        options.resolveGatewayContext() === context &&
        options.getNodeTransport() === nodeTransport &&
        current?.leaseId === environment.leaseId &&
        current?.ownerEpoch === environment.ownerEpoch &&
        current?.nodeDeviceId === node.nodeId &&
        currentNode?.connId === node.connId &&
        currentNode?.pairingGeneration === node.pairingGeneration &&
        currentNode.client.invalidated !== true
      );
    };
    const sourceIsCurrent = () => {
      try {
        source.assertCurrent();
      } catch {
        return false;
      }
      const currentEnvironment = options.store.get(environment.environmentId);
      return (
        environmentIsCurrent(currentEnvironment) &&
        currentEnvironment?.ownerEpoch === source.ownerEpoch &&
        ["ready", "idle", "attached"].includes(currentEnvironment.state) &&
        currentEnvironment.destroyRequestedAtMs === null
      );
    };
    const assertPlacement = () => {
      if (!sourceIsCurrent()) {
        throw new Error("Session desktop placement authority changed");
      }
    };
    assertPlacement();
    // Shared paired hosts retain their approved public contract; disposable workers use only
    // their private endpoint. A failed private probe never selects another connected computer.
    const privateNode = environment.sharedHost
      ? undefined
      : await nodeTransport.getCurrentNode(node.nodeId);
    assertPlacement();
    if (!environment.sharedHost && !privateNode) {
      throw new Error("Session desktop node lacks the current private worker protocol");
    }
    let computerUse = node.computerUse;
    if (privateNode) {
      const result = await nodeTransport.invoke({
        node: privateNode,
        command: NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
        params: { operation: "capabilities" },
        isDispatchAuthorized: sourceIsCurrent,
      });
      assertPlacement();
      if (!nodeTransport.isCurrent(privateNode)) {
        throw new Error("Session desktop private node owner changed");
      }
      if (!result.ok) {
        options.warn(
          "Session computer control is unavailable; enable the desktop provider and reprovision the worker.",
        );
        return undefined;
      }
      computerUse = parseComputerUseCapabilityDescriptor(payload(result));
    } else if (!COMPUTER_COMMANDS.every((command) => node.commands.includes(command))) {
      return undefined;
    }
    if (!computerUse) {
      return undefined;
    }
    const registry = getActivePluginGatewayNodePolicyRegistry();
    if (
      privateNode &&
      !registry?.nodeInvokePolicies.some((entry) => entry.policy.commands.includes("computer.act"))
    ) {
      options.warn(
        "Session computer control is unavailable; enable its provider plugin on the Gateway.",
      );
      return undefined;
    }
    const policyOwners = COMPUTER_COMMANDS.map((command) => {
      const entry = registry?.nodeInvokePolicies.find((item) =>
        item.policy.commands.includes(command),
      );
      const policy = entry?.policy;
      const plugin = registry?.plugins.find((item) => item.id === entry?.pluginId);
      return () =>
        registry?.nodeInvokePolicies.find((item) => item.policy.commands.includes(command)) ===
          entry &&
        entry?.policy === policy &&
        (!plugin ||
          (registry?.plugins.includes(plugin) && plugin.enabled && plugin.status === "loaded"));
    });
    const descriptor = { nodeId: node.nodeId, computerUse };
    const providerGeneration = computerUse.provider.generation;
    let closed = false;
    let closing: Promise<void> | undefined;
    const activeBindings = new Set<{ close(reason: string): Promise<unknown> }>();
    const resourceBindingIsCurrent = () =>
      environmentIsCurrent(options.store.get(environment.environmentId)) &&
      (!privateNode || nodeTransport.isCurrent(privateNode));
    const bindingIsCurrent = () =>
      (!privateNode || nodeTransport.isCurrent(privateNode)) &&
      getActivePluginGatewayNodePolicyRegistry() === registry &&
      policyOwners.every((isCurrent) => isCurrent()) &&
      (privateNode !== undefined ||
        context.nodeRegistry.get(node.nodeId)?.computerUse?.provider.generation ===
          providerGeneration);
    const commandIsAllowed = (command: (typeof COMPUTER_COMMANDS)[number]) => {
      const currentNode = context.nodeRegistry.get(node.nodeId);
      const declaredCommands = privateNode ? [...COMPUTER_COMMANDS] : (currentNode?.commands ?? []);
      return isNodeCommandAllowed({
        command,
        declaredCommands,
        allowlist: resolveNodeCommandAllowlist(context.getRuntimeConfig(), {
          ...currentNode,
          approvedCommands: declaredCommands,
        }),
      }).ok;
    };
    const hasController = () =>
      options.desktopRegistry?.hasController(environment.environmentId, environment.ownerEpoch);

    const parseRequest = (request: Parameters<ComputerToolTransport["invoke"]>[0]) => {
      if (request.nodeId !== node.nodeId) {
        throw new Error("Computer control is bound to this session's desktop");
      }
      if (
        request.command === "computer.act" &&
        Value.Check(ComputerTakeControlParamsSchema, request.commandParams)
      ) {
        return {
          operation: "take-control" as const,
          executionId: request.commandParams.executionId,
        };
      }
      const close =
        request.command === "computer.act" && request.commandParams.action === "__close_execution";
      const input = parseNodeWorkerComputerInput(
        JSON.stringify(
          close
            ? {
                operation: "close",
                executionId: request.commandParams.executionId,
                reason: request.commandParams.reason,
              }
            : {
                operation: request.command === "screen.snapshot" ? "snapshot" : "act",
                providerGeneration,
                params: request.commandParams,
              },
        ),
      );
      if (input.operation === "capabilities") {
        throw new Error("Session computer cannot request another capability check");
      }
      return input;
    };

    const send = async (
      input: Exclude<ReturnType<typeof parseRequest>, { operation: "take-control" }>,
      params: {
        timeoutMs?: number;
        signal?: AbortSignal;
        idempotencyKey?: string;
        authorizeDispatch?: () => Promise<boolean>;
        isDispatchAuthorized: () => boolean;
        onDispatchReady?: (invokeId: string) => void;
      },
    ): Promise<InvokeResult> => {
      const isCurrent = () => resourceBindingIsCurrent() && params.isDispatchAuthorized();
      if (!resourceBindingIsCurrent()) {
        throw new Error("Session computer authority closed before dispatch");
      }
      const command = input.operation === "snapshot" ? "screen.snapshot" : "computer.act";
      const commandParams =
        input.operation === "close"
          ? { action: "__close_execution", executionId: input.executionId, reason: input.reason }
          : input.params;
      return privateNode
        ? await nodeTransport.invoke({
            node: privateNode,
            command: NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
            params: input,
            ...params,
            isDispatchAuthorized: isCurrent,
          })
        : await invokeNodeWithReadinessRetry(
            input.operation === "close"
              ? {
                  invoke: (request) =>
                    context.nodeRegistry.invokeLifecycle({
                      ...request,
                      isDispatchAuthorized: isCurrent,
                    }),
                }
              : context.nodeRegistry,
            {
              nodeId: node.nodeId,
              expectedConnId: node.connId,
              expectedPairingGeneration: node.pairingGeneration,
              command,
              params: commandParams,
              sessionKey: source.sessionKey,
              ...params,
              isDispatchAuthorized: isCurrent,
            },
          );
    };

    return {
      descriptor,
      bind(operationalRunInstance, workerSource) {
        const worker = source.turnClaim?.owner.kind === "worker";
        workerSource?.assertCurrent();
        const runAuthority = getActiveAgentRunDelegatedAuthority(operationalRunInstance);
        const authority = worker ? workerSource?.authority : runAuthority;
        if (
          !runAuthority ||
          !authority ||
          !validateAgentRunDelegatedAuthority(authority) ||
          authority.operationalRunInstance.instanceId !== operationalRunInstance.instanceId ||
          authority.operationalRunInstance.runId !== operationalRunInstance.runId ||
          operationalRunInstance.runId !== source.runId
        ) {
          throw new Error("Session computer requires the exact admitted run");
        }
        const identity: AgentRuntimeIdentity = {
          kind: "agentRuntime",
          agentId: source.agentId,
          sessionKey: source.sessionKey,
          operationalRunInstance,
          delegatedAuthority:
            source.turnClaim?.owner.kind === "worker"
              ? { ...authority, kind: "worker", turnClaim: source.turnClaim }
              : { ...authority, kind: "local" },
        };
        // Tool construction can also build a schema-only projection. Only an actual
        // operation opens a binding; independent projections never retire the active tool.
        let execution: { logicalId: string; physicalId: string } | undefined;
        let bindingClosing: Promise<unknown> | undefined;
        const inFlight = new Set<Promise<unknown>>();
        const inputControllers = new Set<AbortController>();
        const completedTakeovers = takeoversByRun.get(runAuthority) ?? new Set<string>();
        takeoversByRun.set(runAuthority, completedTakeovers);
        let releaseControlListener: (() => void) | undefined;
        let inputNeedsObservation = false;
        let controlGeneration = 0;
        const lifetime = new AbortController();
        const assertCurrent = () => {
          if (
            closed ||
            lifetime.signal.aborted ||
            !bindingIsCurrent() ||
            !validateAgentRunDelegatedAuthority(authority)
          ) {
            throw new Error("Session computer run authority closed");
          }
          workerSource?.assertCurrent();
          assertPlacement();
        };
        assertCurrent();
        const execute = async (
          input: Exclude<ReturnType<typeof parseRequest>, { operation: "close" | "take-control" }>,
          request: Pick<
            Parameters<ComputerToolTransport["invoke"]>[0],
            "timeoutMs" | "signal" | "idempotencyKey"
          >,
          assertAuthorized: (() => void) | undefined,
        ) => {
          const isInput =
            input.operation === "act" &&
            !isComputerObservationAction(
              input.params.action,
              input.params.action === "browser_dialog" ? input.params.dialogAction : undefined,
            );
          const controller = new AbortController();
          if (isInput) {
            inputControllers.add(controller);
          }
          // RPC tool grants can close independently of the run or placement.
          // Carry their exact authority through policy work and the final dispatch.
          const assertInvocationCurrent = () => {
            assertCurrent();
            assertAuthorized?.();
            if (isInput && hasController()) {
              throw new Error(
                "Computer input paused while the operator has control; use take_control when asked to resume, or release control in the Desktop panel",
              );
            }
            if (isInput && inputNeedsObservation) {
              throw new Error(
                "COMPUTER_STALE_OBSERVATION: take a fresh screenshot after desktop control changes",
              );
            }
            controller.signal.throwIfAborted();
          };
          const command = input.operation === "snapshot" ? "screen.snapshot" : "computer.act";
          const commandParams = input.params;
          const isCurrent = () => {
            try {
              assertInvocationCurrent();
              return true;
            } catch {
              return false;
            }
          };
          const signal = AbortSignal.any([
            lifetime.signal,
            controller.signal,
            ...(request.signal ? [request.signal] : []),
          ]);
          try {
            assertInvocationCurrent();
            const dispatch = async (
              params: Parameters<typeof send>[1] & { params: unknown },
            ): Promise<InvokeResult> => {
              const actual = parseNodeWorkerComputerInput(
                JSON.stringify({ ...input, params: params.params }),
              );
              if (
                actual.operation === "capabilities" ||
                actual.operation === "close" ||
                actual.params.executionId !== execution?.physicalId
              ) {
                throw new Error("Computer policy cannot replace the session execution owner");
              }
              return await send(actual, {
                timeoutMs: params.timeoutMs,
                signal: params.signal,
                idempotencyKey: params.idempotencyKey,
                ...(params.authorizeDispatch
                  ? { authorizeDispatch: params.authorizeDispatch }
                  : {}),
                isDispatchAuthorized: () => isCurrent() && params.isDispatchAuthorized(),
                onDispatchReady: params.onDispatchReady,
              });
            };
            const result = await applyPluginNodeInvokePolicy({
              context,
              client: null,
              agentRuntimeIdentity: identity,
              nodeSession: node,
              command,
              params: commandParams,
              sessionKey: source.sessionKey,
              timeoutMs: request.timeoutMs,
              idempotencyKey: request.idempotencyKey,
              signal,
              isInvocationCurrent: isCurrent,
              isApprovalAuthorityActive: isCurrent,
              privateTransport: {
                ...(privateNode ? { commands: COMPUTER_COMMANDS } : {}),
                isCurrent,
                invoke: dispatch,
              },
            });
            assertInvocationCurrent();
            if (result) {
              if (!result.ok) {
                throw new Error(result.message ?? "Session computer action denied");
              }
              return result.payloadJSON ? JSON.parse(result.payloadJSON) : result.payload;
            }
            if ((privateNode && command === "computer.act") || !commandIsAllowed(command)) {
              throw new Error("Session computer command has no active policy or permission");
            }
            const raw = await dispatch({
              params: commandParams,
              timeoutMs: request.timeoutMs,
              signal,
              idempotencyKey: request.idempotencyKey,
              isDispatchAuthorized: () => isCurrent() && commandIsAllowed(command),
            });
            assertInvocationCurrent();
            return payload(raw);
          } finally {
            inputControllers.delete(controller);
          }
        };
        const binding = {
          close(reason: string): Promise<unknown> {
            if (bindingClosing) {
              return bindingClosing;
            }
            lifetime.abort();
            releaseControlListener?.();
            bindingClosing = (async () => {
              await Promise.allSettled(inFlight);
              if (!execution || !resourceBindingIsCurrent()) {
                activeBindings.delete(binding);
                return { ok: true };
              }
              // Releasing an owned native execution survives input-policy revocation.
              // Only this fixed physical close crosses the lease/connection guard;
              // no plugin handler, caller override, approval, or input is revived.
              const result = await send(
                {
                  operation: "close",
                  executionId: execution.physicalId,
                  reason: reason.slice(0, 64),
                },
                { isDispatchAuthorized: resourceBindingIsCurrent },
              );
              if (!resourceBindingIsCurrent()) {
                throw new Error("Session computer cleanup owner changed");
              }
              const output = payload(result);
              activeBindings.delete(binding);
              return output;
            })();
            return bindingClosing;
          },
        };
        return {
          computerUse,
          async resolveNode(query, signal) {
            signal?.throwIfAborted();
            assertCurrent();
            if (query !== undefined && query !== node.nodeId) {
              throw new Error("Computer control is bound to this session's desktop");
            }
            return descriptor;
          },
          async invoke(request, assertAuthorized) {
            const input = parseRequest(request);
            const logicalId =
              input.operation === "close" || input.operation === "take-control"
                ? input.executionId
                : input.params.executionId;
            if (execution && logicalId !== execution.logicalId) {
              throw new Error("Session computer execution owner changed");
            }
            if (input.operation === "close") {
              return binding.close(input.reason);
            }
            assertCurrent();
            request.signal?.throwIfAborted();
            assertAuthorized?.();
            if (input.operation === "take-control") {
              if (!environment.desktop || !options.desktopRegistry) {
                throw new Error("Agent takeover is unavailable for this session desktop");
              }
              if (!commandIsAllowed("computer.act")) {
                throw new Error("Session computer command has no active policy or permission");
              }
              // Every takeover needs a replay identity before it can evict a human controller.
              if (!request.idempotencyKey) {
                throw new Error("Agent takeover requires an idempotency key");
              }
              const takeoverKey = JSON.stringify([
                environment.environmentId,
                environment.ownerEpoch,
                request.idempotencyKey,
              ]);
              if (!completedTakeovers.has(takeoverKey)) {
                // Even without a controller, retire observations started before takeover.
                inputNeedsObservation = true;
                controlGeneration += 1;
                options.desktopRegistry.takeControl(
                  environment.environmentId,
                  environment.ownerEpoch,
                );
                completedTakeovers.add(takeoverKey);
              }
              assertCurrent();
              assertAuthorized?.();
              request.signal?.throwIfAborted();
              if (hasController()) {
                throw new Error(
                  "The operator took control again; observe before requesting another takeover",
                );
              }
              return { ok: true };
            }
            // Remote execution IDs are correlation only. The Gateway alone mints
            // the native owner, so a copied UUID cannot join or close another binding.
            execution ??= { logicalId, physicalId: randomUUID() };
            activeBindings.add(binding);
            releaseControlListener ??= options.desktopRegistry?.onControlChanged(
              environment.environmentId,
              environment.ownerEpoch,
              (controlled) => {
                inputNeedsObservation = true;
                controlGeneration += 1;
                if (controlled) {
                  for (const controller of inputControllers) {
                    controller.abort(
                      new Error("Computer input paused while the operator has control"),
                    );
                  }
                }
              },
            );
            input.params.executionId = execution.physicalId;
            const observedControlGeneration = controlGeneration;
            const operation = execute(input, request, assertAuthorized).then((result) => {
              if (
                input.operation === "snapshot" &&
                controlGeneration === observedControlGeneration &&
                !hasController()
              ) {
                inputNeedsObservation = false;
              }
              return result;
            });
            inFlight.add(operation);
            void operation.finally(() => inFlight.delete(operation)).catch(() => {});
            return operation;
          },
        };
      },
      close(reason) {
        if (closing) {
          return closing;
        }
        closed = true;
        closing = (async () => {
          const results = await Promise.allSettled(
            [...activeBindings].map((binding) => binding.close(reason)),
          );
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length) {
            throw new AggregateError(
              failures.map((failure) => failure.reason),
              "Session computer cleanup failed",
            );
          }
        })();
        return closing;
      },
    };
  };
}

/** Placement admission retains its exact turn claim; attachments use the same transport owner. */
export function createWorkerComputerTransportOwner(
  options: WorkerComputerOwnerOptions & {
    placements: Pick<WorkerSessionPlacementStore, "get" | "getAsync" | "validateTurnClaim">;
  },
) {
  const create = createEnvironmentComputerTransportOwner(options);
  return async (claim: WorkerSessionTurnClaim): Promise<PreparedWorkerComputer | undefined> => {
    const placement = await options.placements.getAsync(claim.sessionId);
    if (placement?.state !== "active" || !options.placements.validateTurnClaim(claim)) {
      throw new Error("Session desktop placement is no longer active");
    }
    return create({
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      sessionId: claim.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      runId: claim.runId,
      turnClaim: claim,
      assertCurrent() {
        const current = options.placements.get(claim.sessionId);
        const environment = options.store.get(placement.environmentId);
        if (
          !options.placements.validateTurnClaim(claim) ||
          current?.state !== "active" ||
          current.generation !== claim.placementGeneration ||
          current.sessionKey !== placement.sessionKey ||
          current.agentId !== placement.agentId ||
          current.environmentId !== placement.environmentId ||
          current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
          environment?.state !== "attached" ||
          environment.attachedSessionIds.length !== 1 ||
          environment.attachedSessionIds[0] !== claim.sessionId
        ) {
          throw new Error("Session desktop placement authority changed");
        }
      },
    });
  };
}
