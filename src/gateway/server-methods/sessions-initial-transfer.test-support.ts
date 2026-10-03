import { expectDefined } from "@openclaw/normalization-core";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";

export async function withRequesterTestAuthority<T>(
  runId: string,
  sessionKey: string,
  run: (retire: () => void) => Promise<T>,
  operatorAuthority?: AdmittedRunOperatorAuthority,
): Promise<T> {
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  registerAgentRunContext(runId, {
    agentId: "main",
    sessionKey,
    sessionId: `${sessionKey}-session`,
  });
  let retired = false;
  const retire = () => {
    if (!retired) {
      retired = true;
      releaseAgentRunDelegatedAuthority(authority);
      clearAgentRunContext(runId);
    }
  };
  try {
    const creator = expectDefined(
      createCronCreatorAuthorityCapability(
        runId,
        { kind: "external", channel: "discord" },
        { source: "channel-owner", isCurrent: () => true },
      ),
      "original requester authority",
    );
    return await runWithCronCreatorAuthorityCapability(creator, () =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          operationalRunInstance,
          approvalAuthority: authority,
          ...(operatorAuthority ? { operatorAuthority } : {}),
          receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
        },
        () => run(retire),
      ),
    );
  } finally {
    retire();
  }
}
