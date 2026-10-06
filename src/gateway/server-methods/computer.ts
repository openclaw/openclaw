import {
  ErrorCodes,
  errorShape,
  validateComputerInvokeParams,
  validateComputerStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { computerRunOwner } from "../desktop/computer-owner.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveComputerCaller(
  options: GatewayRequestHandlerOptions,
  purpose: "status" | "invoke" | "close",
): {
  owner: string;
  signal?: AbortSignal;
  ownerSignal?: AbortSignal;
  assertCurrent: () => void;
} {
  const { client, context, hasCurrentClientAuthority, sessionMutationCommitGuard } = options;
  const identity = client?.internal?.agentRuntimeIdentity;
  const discovery = purpose === "status" && client?.internal?.syntheticClient === true;
  if (
    !client ||
    (!client.connId && !discovery) ||
    (client.internal?.syntheticClient && !identity && !discovery)
  ) {
    throw new Error("Gateway computer requires an authenticated operator or admitted agent run");
  }
  const connId = client.connId;
  const signals = [options.signal, client.connectionSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  return {
    owner: identity
      ? computerRunOwner(identity.delegatedAuthority)
      : JSON.stringify([discovery ? "discovery" : "operator", connId]),
    signal,
    ...(!identity && !client.internal?.syntheticClient && client.connectionSignal
      ? { ownerSignal: client.connectionSignal }
      : {}),
    assertCurrent: () => {
      sessionMutationCommitGuard?.();
      signal?.throwIfAborted();
      if (client.invalidated || hasCurrentClientAuthority?.() === false) {
        throw new Error("Gateway computer requester authority is no longer current");
      }
      if (identity && purpose === "invoke") {
        if (context.validateAgentRuntimeApprovalAuthority?.(identity) !== true) {
          throw new Error("Gateway computer agent run authority is no longer current");
        }
        client.internal?.agentToolCaller?.assertCurrent?.();
      } else if (
        !client.internal?.syntheticClient &&
        connId &&
        context.isConnectionActive?.(connId) === false
      ) {
        throw new Error("Gateway computer requester connection is no longer active");
      }
    },
  };
}

export const computerHandlers: GatewayRequestHandlers = {
  "computer.status": async (options) => {
    const { params, respond, context } = options;
    if (!assertValidParams(params, validateComputerStatusParams, "computer.status", respond)) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const caller = resolveComputerCaller(options, "status");
      caller.assertCurrent();
      const result = context.gatewayComputerService
        ? await context.gatewayComputerService.status()
        : { available: false, configured: false };
      caller.assertCurrent();
      respond(true, result);
    });
  },
  "computer.invoke": async (options) => {
    const { params, respond, context } = options;
    if (!assertValidParams(params, validateComputerInvokeParams, "computer.invoke", respond)) {
      return;
    }
    const service = context.gatewayComputerService;
    if (!service) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Gateway computer is unavailable"),
      );
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      // Closing can only retire this caller's existing execution; the service
      // verifies its owner and never grants fresh input authority from cleanup.
      const purpose =
        params.command === "computer.act" && params.params.action === "__close_execution"
          ? "close"
          : "invoke";
      const caller = resolveComputerCaller(options, purpose);
      caller.assertCurrent();
      // The service composes this guard into its final dispatch after preparing the desktop.
      const payload = await service.invoke({ ...params, ...caller });
      respond(true, { payload });
    });
  },
};
