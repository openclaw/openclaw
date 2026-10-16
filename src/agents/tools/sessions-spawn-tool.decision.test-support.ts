import { configureExecutionDecisionWorkSink } from "../../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../../audit/execution-decision-work.types.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

export async function captureSessionDecisionWork<T>(run: () => Promise<T>): Promise<{
  result: T;
  work: ExecutionDecisionWork[];
  token: ReturnType<typeof createExecutionIdentityAdmissionToken>;
}> {
  const work: ExecutionDecisionWork[] = [];
  const clear = configureExecutionDecisionWorkSink((item) => {
    work.push(item);
    return true;
  });
  try {
    const token = createExecutionIdentityAdmissionToken("sessions-spawn-action", {
      contextId: "sessions-spawn-context",
      executionId: "sessions-spawn-execution",
    });
    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        executionIdentityToken: token,
        receiptAuthority: () => true,
      },
      run,
    );
    return { result, work, token };
  } finally {
    clear();
  }
}
