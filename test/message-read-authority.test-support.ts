import { createOperationalRunInstanceRef } from "../src/agents/admitted-run-context.js";
import { wrapToolWithGatewayCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import type { InternalChannelThreadingToolContext } from "../src/channels/threading-tool-context-internal.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../src/gateway/agent-runtime-approval-authority.js";
import {
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";
import { createAgentRuntimeAuthorityGuard } from "../src/gateway/server-methods/agent-runtime-authority.js";
import type { GatewayClient, GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../src/infra/agent-run-registry.js";

export function createMessageReadAuthority<T extends InternalChannelThreadingToolContext>(params: {
  runId: string;
  sessionKey: string;
  requesterSenderId: string;
  toolContext: T;
  gatewayContext: "resolved" | "expiry-only";
}) {
  const { runId, sessionKey, requesterSenderId, toolContext } = params;
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const delegated = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const identity = { agentId: "main", runId: operationalRunInstance.runId, sessionKey };
  const capability = mintMessageActionTurnCapability({
    ...identity,
    requesterAccountId: "default",
    requesterSenderId,
    toolContext,
  });
  const context =
    params.gatewayContext === "resolved"
      ? resolveMessageActionTurnCapability({ token: capability, ...identity })
      : { expiresAtMs: Date.now() + 60_000 };
  if (!context) {
    throw new Error("Missing admitted message-read turn context");
  }
  const client = {
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        delegatedAuthority: { kind: "local", ...delegated },
        messageActionContext: { ...context, turnCapability: capability },
      },
    },
  } as GatewayClient;
  const validate = createAgentRuntimeApprovalAuthorityValidator();
  const assert = createAgentRuntimeAuthorityGuard(
    client,
    { validateAgentRuntimeApprovalAuthority: validate } as GatewayRequestContext,
    () => {},
  ).commitGuard;
  if (!assert) {
    throw new Error("Missing originating message-read authority");
  }
  assert();
  const options = {
    agentId: "main",
    agentAccountId: "default",
    agentSessionKey: sessionKey,
    runId: operationalRunInstance.runId,
    messageActionTurnCapability: capability,
    ...toolContext,
  };
  const wrap = (tool: ReturnType<typeof createMessageTool>) =>
    wrapToolWithGatewayCallerIdentity(tool, {
      agentId: "main",
      sessionKey,
      operationalRunInstance,
      receiptAuthority: () => validateAgentRunDelegatedAuthority(delegated),
    });
  const revokeTurn = () => revokeMessageActionTurnCapability(capability);
  const releaseClaim = () => releaseAgentRunDelegatedAuthority(delegated);
  return {
    assert,
    client,
    validate,
    toolContext,
    options,
    wrap,
    revokeTurn,
    releaseClaim,
    createTool: (config: OpenClawConfig) => wrap(createMessageTool({ ...options, config })),
    dispose: () => {
      revokeTurn();
      releaseClaim();
    },
  };
}
