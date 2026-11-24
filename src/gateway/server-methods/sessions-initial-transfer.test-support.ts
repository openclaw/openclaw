import { expectDefined } from "@openclaw/normalization-core";
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
        { source: "channel-owner" },
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
          receiptAuthority: () => {
            if (!validateAgentRunDelegatedAuthority(authority)) {
              throw new Error("agent tool caller authority is no longer active");
            }
          },
        },
        () => run(retire),
      ),
    );
  } finally {
    retire();
  }
}
