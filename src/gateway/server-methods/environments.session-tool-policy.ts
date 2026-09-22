import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { isConversationToolAllowed } from "../../agents/conversation-tool-policy-pipeline.js";
import { isRuntimeToolAllowed, isToolAllowedByPolicyName } from "../../agents/tool-policy-match.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { WorkerEnvironmentSessionIdentity } from "../worker-environments/session-attachment.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Delegating a tool through an environment retains both its admitted cap and current policy. */
export function captureSessionEnvironmentToolPolicy(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context">,
  caller: { identity: WorkerEnvironmentSessionIdentity; assertCurrent: () => void },
  tool: "exec" | "process" | "screen",
) {
  const ambient = getGatewayToolCallerIdentity();
  const runtime = options.client?.internal?.agentRuntimeIdentity;
  const run = ambient?.operationalRunInstance;
  const assertCapturedToolAllowed = ambient?.assertToolAllowed;
  const inherited = runtime?.sessionSpawnContext?.inheritedToolPolicy;
  const inheritedPolicy = inherited
    ? { allow: [...inherited.allow], deny: [...inherited.deny] }
    : undefined;
  return {
    cronExecAskAlways:
      ambient?.cronExecToolTarget?.ask === "always" ||
      runtime?.cronExecToolTarget?.ask === "always",
    assertAllowed: () => {
      caller.assertCurrent();
      if (ambient) {
        if (
          !run ||
          !assertCapturedToolAllowed ||
          ambient.agentId !== caller.identity.agentId ||
          ambient.sessionKey !== caller.identity.sessionKey ||
          (runtime &&
            (runtime.operationalRunInstance.instanceId !== run.instanceId ||
              runtime.operationalRunInstance.runId !== run.runId))
        ) {
          throw new Error(`Environment ${tool} has no matching captured tool authority`);
        }
        assertCapturedToolAllowed(tool);
      } else if ((runtime || options.client?.internal?.agentToolCaller) && !inheritedPolicy) {
        throw new Error(`Environment ${tool} has no captured tool authority`);
      }
      const capability = resolveConversationCapabilityProfile({
        config: options.context.getRuntimeConfig(),
        ...caller.identity,
        modelProvider: runtime?.sessionSpawnContext?.resolvedModel?.provider,
        modelId: runtime?.sessionSpawnContext?.resolvedModel?.model,
      });
      if (
        !isConversationToolAllowed(capability, tool) ||
        (inheritedPolicy &&
          (!isRuntimeToolAllowed(tool, inheritedPolicy.allow) ||
            !isToolAllowedByPolicyName(tool, { deny: inheritedPolicy.deny })))
      ) {
        throw new Error(`Conversation policy denies ${tool}`);
      }
    },
  };
}
