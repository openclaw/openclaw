import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { isConversationToolAllowed } from "../../agents/conversation-tool-policy-pipeline.js";
import { captureActiveEmbeddedRunDelegatedToolParameters } from "../../agents/embedded-agent-runner/run-tool-policy.js";
import type { DelegatedToolParameterPolicy } from "../../agents/inherited-tool-parameters.types.js";
import { createInheritedToolPolicyMatcher } from "../../agents/inherited-tool-policy.js";
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
  const inheritedPolicy = inherited?.version === 2 ? inherited.policy : undefined;
  const activePolicy = ambient?.embeddedRunToolAuthorityBinding
    ? captureActiveEmbeddedRunDelegatedToolParameters(caller.identity.sessionId)
    : undefined;
  const currentCapability = () =>
    resolveConversationCapabilityProfile({
      config: options.context.getRuntimeConfig(),
      ...caller.identity,
      modelProvider: runtime?.sessionSpawnContext?.resolvedModel?.provider,
      modelId: runtime?.sessionSpawnContext?.resolvedModel?.model,
    });
  const parameterPolicies = (): DelegatedToolParameterPolicy[] => {
    const current = currentCapability().policy.inheritedActionPolicy;
    return [
      ...(activePolicy ? [activePolicy()] : []),
      ...(inheritedPolicy ? [inheritedPolicy.parameters] : []),
      ...(current ? [current.parameters] : []),
    ];
  };
  const legacyPolicy =
    inherited?.version === 1
      ? { allow: [...inherited.allow], deny: [...inherited.deny] }
      : undefined;
  return {
    requiresInheritedApproval: () =>
      tool === "exec" &&
      parameterPolicies().some((policy) =>
        policy.exec.some((entry) => entry.security !== "full" || entry.ask !== "off"),
      ),
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
      } else if (
        (runtime || options.client?.internal?.agentToolCaller) &&
        !inheritedPolicy &&
        !legacyPolicy
      ) {
        throw new Error(`Environment ${tool} has no captured tool authority`);
      }
      const capability = currentCapability();
      for (const policy of parameterPolicies()) {
        // Attached commands have no portable host allowlist, sandbox attestation,
        // or strict shell parser. Never turn these restrictions into approval.
        if (
          policy.sandbox.length ||
          policy.unsupported.some(
            (entry) => entry.scope === "sandbox" || (tool === "exec" && entry.scope === "exec"),
          )
        ) {
          throw new Error(
            `Attached environment cannot enforce inherited ${tool} resource restrictions`,
          );
        }
        if (
          tool === "exec" &&
          policy.exec.some(
            (entry) =>
              entry.security === "deny" ||
              entry.strictInlineEval ||
              (entry.security === "allowlist" && entry.ask === "off") ||
              (entry.host !== "auto" && entry.host !== "gateway"),
          )
        ) {
          throw new Error("Attached environment cannot enforce inherited exec restrictions");
        }
      }
      if (
        !isConversationToolAllowed(capability, tool) ||
        (inheritedPolicy &&
          !createInheritedToolPolicyMatcher({ policy: inheritedPolicy })({ name: tool })) ||
        (legacyPolicy &&
          (!isRuntimeToolAllowed(tool, legacyPolicy.allow) ||
            !isToolAllowedByPolicyName(tool, { deny: legacyPolicy.deny })))
      ) {
        throw new Error(`Conversation policy denies ${tool}`);
      }
    },
  };
}
