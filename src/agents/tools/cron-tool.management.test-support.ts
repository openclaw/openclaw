import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

export async function withCronManagementCaller<T>(
  runId: string,
  run: (identity: AgentRuntimeIdentity) => Promise<T>,
  origin: "unknown" | "channel-owner" = "unknown",
): Promise<T> {
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const capability = createCronCreatorAuthorityCapability(
    runId,
    origin === "channel-owner" ? { kind: "external", channel: "discord" } : { kind: origin },
    origin === "channel-owner"
      ? { source: "channel-owner", isCurrent: () => true }
      : { source: "control-ui-admin" },
  );
  if (!capability) {
    throw new Error("expected management authority capability");
  }
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:control-ui",
    operationalRunInstance,
    delegatedAuthority: { ...authority, kind: "local" },
  };
  try {
    return await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, () =>
        run(identity),
      ),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}
