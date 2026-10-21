import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, onTestFinished, type Mock } from "vitest";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

export type Caller = NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]>;
export type ActiveCaller = Caller & {
  operationalRunInstance: NonNullable<Caller["operationalRunInstance"]>;
};
export function gatewayContext(
  getRuntimeConfig: GatewayRequestContext["getRuntimeConfig"],
  overrides: Partial<GatewayRequestContext> = {},
): GatewayRequestContext {
  return {
    trackExecution: (run) => run(),
    getRuntimeConfig,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    ...overrides,
  } as GatewayRequestContext;
}
export function capturedRequest<T extends (...args: never[]) => unknown>(mock: Mock<T>) {
  expect(mock).toHaveBeenCalledOnce();
  return expectDefined(mock.mock.calls[0]?.[0], "Gateway request");
}
export async function withCaller<T>(
  overrides: Partial<Caller>,
  run: (caller: ActiveCaller, authority: AgentRunDelegatedAuthority) => Promise<T>,
) {
  const caller = {
    agentId: "ops",
    sessionKey: "agent:ops:main",
    ...overrides,
    operationalRunInstance:
      overrides.operationalRunInstance ?? createOperationalRunInstanceRef("run-1"),
  };
  const authority = claimAgentRunDelegatedAuthority(caller.operationalRunInstance);
  onTestFinished(() => void releaseAgentRunDelegatedAuthority(authority));
  try {
    return await withGatewayToolCallerIdentity(
      {
        ...caller,
        receiptAuthority: () =>
          validateAgentRunDelegatedAuthority(authority) && caller.receiptAuthority?.() !== false,
      },
      () => run(caller, authority),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}
