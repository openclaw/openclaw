import type { AdmittedRunContext } from "../../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import * as embeddedRuns from "../../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../../agents/embedded-agent-runner/runs.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../../agents/tools/gateway-caller-context.js";

export async function withRegisteredNativeEmbeddedRun<T>(
  params: Pick<RunEmbeddedAgentParams, "preparedRunAdmission" | "runId" | "sessionTarget">,
  run: (admittedRunContext: AdmittedRunContext) => Promise<T> | T,
): Promise<T> {
  const { preparedRunAdmission } = params;
  const { agentId, sessionId, sessionKey } = params.sessionTarget ?? {};
  if (!agentId || !sessionId || !preparedRunAdmission || !sessionKey) {
    throw new Error("Expected real Talk admission");
  }
  const admittedRunContext = await preparedRunAdmission.admit("embedded", "native-test-backend");
  return await withGatewayToolCallerIdentity(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext,
      agentId,
      sessionKey,
    }),
    async () => {
      const handle = createEmbeddedRunHandle({ runId: params.runId });
      embeddedRuns.setActiveEmbeddedRun(sessionId, handle, sessionKey);
      try {
        return await run(admittedRunContext);
      } finally {
        embeddedRuns.clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      }
    },
  );
}
