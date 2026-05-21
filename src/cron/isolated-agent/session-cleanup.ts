import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronJob } from "../types.js";

const gatewayCallRuntimeLoader = createLazyImportLoader(
  () => import("../../gateway/call.runtime.js"),
);

async function loadGatewayCallRuntime(): Promise<typeof import("../../gateway/call.runtime.js")> {
  return await gatewayCallRuntimeLoader.load();
}

export async function cleanupCronRunSessionAfterRun(params: {
  job: Pick<CronJob, "deleteAfterRun">;
  agentSessionKey: string;
  sessionId: string;
  reason: string;
}): Promise<boolean> {
  if (!params.job.deleteAfterRun) {
    return false;
  }
  if (!isCronSessionKey(params.agentSessionKey)) {
    return true;
  }
  try {
    const { callGateway } = await loadGatewayCallRuntime();
    await callGateway({
      method: "sessions.delete",
      params: {
        key: params.agentSessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  } catch {
    await retireSessionMcpRuntime({
      sessionId: params.sessionId,
      reason: params.reason,
    });
  }
  return true;
}
