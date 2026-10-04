import crypto from "node:crypto";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { ComputerUseCapabilityDescriptor } from "../../plugins/computer-use-contract.js";
import {
  type EligibleNodeMessages,
  resolveEligibleNodeFromList,
} from "../../shared/node-resolve.js";
import { isEligibleComputerNode } from "../computer-use-node-capabilities.js";
import {
  bindGatewayComputerCleanup,
  loadGatewayComputerStatus,
  type GatewayComputerStatus,
} from "./computer-tool-gateway.js";
import type { ComputerHost, ComputerToolTransport } from "./computer-tool-shared.js";
import { COMPUTER_ACT_COMMAND, SCREEN_SNAPSHOT_COMMAND } from "./computer-tool-shared.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import {
  callGatewayTool,
  shouldUseInProcessGatewayTool,
  type GatewayCallOptions,
} from "./gateway.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";
import { invokeAgentNodeCommand, listNodes, type NodeListNode } from "./nodes-utils.js";

export type ComputerBinding = {
  host: ComputerHost;
  gatewayOpts: GatewayCallOptions;
  capabilities?: ComputerUseCapabilityDescriptor;
  invoke: (
    request: Omit<Parameters<ComputerToolTransport["invoke"]>[0], "nodeId">,
  ) => Promise<unknown>;
};

export const NOT_COMPUTER_CAPABLE_HINT =
  "enable Computer Control in the OpenClaw app and approve the pairing update";
const COMPUTER_NODE_MESSAGES: EligibleNodeMessages<NodeListNode> = {
  ineligibleExact: (query, eligibleIds) =>
    `node "${query}" is not computer-capable (needs a connected node advertising ${COMPUTER_ACT_COMMAND} and ${SCREEN_SNAPSHOT_COMMAND}; ${NOT_COMPUTER_CAPABLE_HINT}; ` +
    `eligible node ids: ${eligibleIds})`,
  nameResolveFailed: (reason, eligibleIds) =>
    `${reason} (eligible computer-capable node ids: ${eligibleIds})`,
  noneEligible: () =>
    `no connected computer-capable node (a node must advertise ${COMPUTER_ACT_COMMAND} and ${SCREEN_SNAPSHOT_COMMAND}; ${NOT_COMPUTER_CAPABLE_HINT})`,
  multipleEligible: (eligible) =>
    `multiple computer-capable nodes connected; pass node explicitly: ${eligible
      .map((node) => node.nodeId)
      .join(", ")}`,
};

export async function resolveComputerBinding(params: {
  executionId: string;
  sessionTransport?: ComputerToolTransport;
  gatewayStatus?: GatewayComputerStatus;
  target?: "gateway" | "node";
  node?: string;
  environmentId?: string;
  gatewayOpts: GatewayCallOptions;
  signal?: AbortSignal;
}): Promise<ComputerBinding> {
  if (params.environmentId !== undefined) {
    const caller = getGatewayToolCallerIdentity();
    const assertCaller = captureGatewayToolCallerAssertion();
    const resolveContext = () => getInProcessGatewayToolContext(caller?.gatewayContextResolver);
    const context = resolveContext();
    const service = context?.workerEnvironmentService;
    const run = caller?.operationalRunInstance;
    const runAuthority = run ? getActiveAgentRunDelegatedAuthority(run) : undefined;
    if (!caller || !assertCaller || !run || !runAuthority || !service?.prepareAttachedComputer) {
      throw new Error("Attached computer control requires an admitted agent run on its Gateway");
    }
    assertCaller();
    const attachment = service.findSessionAttachment(caller);
    if (!attachment || attachment.environmentId !== params.environmentId) {
      throw new Error("Computer environment is not attached to this conversation");
    }
    const assertCurrent = () => {
      if (!validateAgentRunDelegatedAuthority(runAuthority) || resolveContext() !== context) {
        throw new Error("Attached computer Gateway owner changed");
      }
      service.assertSessionAttachment(attachment);
    };
    await service.touchSessionAttachment(attachment);
    assertCaller();
    assertCurrent();
    const prepared = await service.prepareAttachedComputer({
      ...attachment,
      runId: run.runId,
      assertCurrent,
    });
    try {
      assertCaller();
      assertCurrent();
      if (!prepared) {
        throw new Error(
          "Attached environment has no available computer provider; use a desktop-enabled profile",
        );
      }
      const transport = prepared.bind(run);
      const node = await transport.resolveNode(undefined, params.signal);
      assertCaller();
      assertCurrent();
      return {
        host: { host: "node", nodeId: node.nodeId, environmentId: attachment.environmentId },
        gatewayOpts: {},
        capabilities: node.computerUse,
        invoke: async (request) => {
          if (
            request.command === COMPUTER_ACT_COMMAND &&
            request.commandParams.action === "__close_execution"
          ) {
            await prepared.close("execution-complete");
            return { ok: true };
          }
          const invokingCaller = getGatewayToolCallerIdentity();
          const assertInvocation = captureGatewayToolCallerAssertion();
          if (
            !assertInvocation ||
            invokingCaller?.operationalRunInstance !== run ||
            invokingCaller.agentId !== attachment.agentId ||
            invokingCaller.sessionKey !== attachment.sessionKey
          ) {
            throw new Error("Attached computer invocation lost its admitted caller");
          }
          assertInvocation();
          await service.touchSessionAttachment(attachment);
          assertInvocation();
          assertCurrent();
          const result = await transport.invoke(
            { ...request, nodeId: node.nodeId },
            assertInvocation,
          );
          assertInvocation();
          await service.touchSessionAttachment(attachment);
          assertInvocation();
          assertCurrent();
          return result;
        },
      };
    } catch (error) {
      await prepared?.close("prepare-failed");
      throw error;
    }
  }
  const sessionTransport = params.sessionTransport;
  if (sessionTransport) {
    const node = await sessionTransport.resolveNode(params.node, params.signal);
    return {
      host: { host: "node", nodeId: node.nodeId },
      gatewayOpts: {},
      capabilities: sessionTransport.computerUse ?? node.computerUse,
      invoke: (request) => sessionTransport.invoke({ ...request, nodeId: node.nodeId }),
    };
  }
  const gatewayOverride =
    params.gatewayOpts.gatewayUrl !== undefined || params.gatewayOpts.gatewayToken !== undefined;
  // Published remote Gateways select paired nodes without the newer computer RPCs.
  if (
    params.target !== "node" &&
    params.node === undefined &&
    (params.target === "gateway" || !gatewayOverride)
  ) {
    const assertHostedCaller = () => {
      if (
        !shouldUseInProcessGatewayTool(params.gatewayOpts) ||
        !getGatewayToolCallerIdentity()?.operationalRunInstance
      ) {
        throw new Error(
          "Gateway computer control requires an agent run hosted by that Gateway. " +
            "Use a paired node, or use computer.invoke over one persistent operator RPC connection.",
        );
      }
    };
    if (params.target === "gateway") {
      assertHostedCaller();
    }
    const prepared = !gatewayOverride ? params.gatewayStatus : undefined;
    const usePrepared =
      prepared?.available === true ||
      (prepared?.configured === false && params.target !== "gateway");
    const gateway =
      (usePrepared ? prepared : undefined) ??
      (await loadGatewayComputerStatus(params.gatewayOpts, params.signal));
    if (gateway.available) {
      assertHostedCaller();
      const close = await bindGatewayComputerCleanup({
        options: params.gatewayOpts,
        generation: gateway.computerUse.provider.generation,
        executionId: params.executionId,
      });
      return {
        host: { host: "gateway" },
        gatewayOpts: params.gatewayOpts,
        capabilities: gateway.computerUse,
        invoke: async (request) => {
          if (
            close &&
            request.command === COMPUTER_ACT_COMMAND &&
            request.commandParams.action === "__close_execution"
          ) {
            return await close(
              typeof request.commandParams.reason === "string"
                ? request.commandParams.reason
                : "completed",
            );
          }
          const raw = await callGatewayTool<{ payload: unknown }>(
            "computer.invoke",
            params.gatewayOpts,
            {
              generation: gateway.computerUse.provider.generation,
              command: request.command,
              params: request.commandParams,
              timeoutMs: request.timeoutMs,
              idempotencyKey: request.idempotencyKey ?? crypto.randomUUID(),
            },
            { signal: request.signal },
          );
          return raw.payload;
        },
      };
    }
    if (gateway.configured || params.target === "gateway") {
      throw new Error(
        (gateway.configured ? gateway.error : undefined) ??
          "Gateway computer is unavailable; enable its computer provider and desktop session",
      );
    }
  }
  const node = resolveEligibleNodeFromList(
    await listNodes(params.gatewayOpts, params.signal),
    params.node,
    isEligibleComputerNode,
    COMPUTER_NODE_MESSAGES,
  );
  return {
    host: { host: "node", nodeId: node.nodeId },
    gatewayOpts: params.gatewayOpts,
    capabilities: node.computerUse,
    invoke: (request) =>
      invokeAgentNodeCommand({ ...request, nodeId: node.nodeId, gatewayOpts: params.gatewayOpts }),
  };
}
