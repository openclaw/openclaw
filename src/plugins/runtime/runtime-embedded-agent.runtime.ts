/** Lazy runtime adapter for plugin-owned embedded-agent execution. */
import { randomUUID } from "node:crypto";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { runEmbeddedAgent as runEmbeddedAgentCore } from "../../agents/embedded-agent.js";
import { recordRuntimeActionDecision } from "../../audit/runtime-action-decision.js";
import {
  getReplyPayloadMetadata,
  isFastModeAutoProgressPayload,
  isReplyPayloadTerminalContent,
} from "../../auto-reply/reply-payload.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSendableOutboundReplyParts } from "../../infra/outbound/reply-payload-parts.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

export const runPluginEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (
  params,
) => {
  const pluginId = getPluginRuntimeGatewayRequestScope()?.pluginId;
  if (!pluginId) {
    throw new Error("Plugin embedded-agent execution requires an active plugin runtime scope.");
  }
  if (
    "admittedRunContext" in params ||
    "preparedRunAdmission" in params ||
    "compactionCountOwner" in params ||
    "onCompactionAccounting" in params ||
    "onContextAccountingEvent" in params ||
    "onDeferredLifecycleOwner" in params ||
    "onDeferredLifecycleAbort" in params ||
    "onRetryWait" in params
  ) {
    throw new Error("Plugin embedded-agent execution cannot supply host run authority.");
  }
  params.abortSignal?.throwIfAborted();
  // A deferred caller (e.g. a plugin hook scheduling follow-up work after its
  // triggering command's root already released) must not inherit that released
  // root via AsyncLocalStorage: subordinate admission checks would reject this
  // run as draining even though the Gateway is healthy. A live parent root,
  // however, keeps its right to finish subordinate work across a reversible
  // suspension, so reserve a tracked continuation off it instead of forcing
  // this call through the closed-admission wait every new detached root uses;
  // only a missing/released parent falls back to that wait.
  return await runWithGatewayDetachedWorkContinuation(
    () => runAdmittedPluginEmbeddedAgent(pluginId, params),
    `plugin:${pluginId}:run-embedded-agent`,
    params.abortSignal,
  );
};

async function runAdmittedPluginEmbeddedAgent(
  pluginId: string,
  params: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0],
): ReturnType<PluginRuntime["agent"]["runEmbeddedAgent"]> {
  const decisionOccurrenceId = randomUUID();
  let admittedRunContext: AdmittedRunContext | undefined;
  const config = params.config ?? getRuntimeConfig();
  const preparedRunAdmission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(params.runId),
    facts: {
      runId: params.runId,
      agentId: params.sessionTarget?.agentId ?? params.agentId ?? "main",
      ingress: {
        kind: "plugin",
        boundary: "plugin-runtime",
        rawSourceRef: pluginId,
        state: "present",
      },
    },
    onAdmitted: (context) => {
      admittedRunContext = context;
      const token = context.executionIdentityToken;
      recordRuntimeActionDecision({
        token,
        family: "plugin",
        operation: "run",
        outcome: "allowed",
        coverageState: "enforced",
        reasonCode: "plugin_runtime_owner_admitted",
        owner: "plugin-runtime",
        decisionBoundary: "plugin.runtime.run-embedded-agent",
        policyRefs: ["plugin:registered-owner", "run:admission"],
        summary: "The registered plugin owner passed exact run admission.",
        remediation: [],
        discriminator: JSON.stringify([pluginId, params.runId, decisionOccurrenceId, "admission"]),
      });
    },
  });
  let closed = false;
  let legacyReplyCustodyIndex = -1;
  let minimumReplyMessageIndex = 0;
  const close = () => {
    if (!closed) {
      closed = true;
      legacyReplyCustodyIndex = -1;
      preparedRunAdmission.close();
    }
  };
  // Abort owns authority revocation independently of core completion; the
  // post-registration check closes the prepare-to-listener race.
  params.abortSignal?.addEventListener("abort", close, { once: true });
  try {
    params.abortSignal?.throwIfAborted();
    const { githubPublicationAvailable: _, ...runParams } = params;
    const onBlockReply = runParams.onBlockReply;
    if (onBlockReply && !runParams.resolveReplyDelivery) {
      // Shipped block callbacks own normal channel messages, unlike partial
      // previews. Handoff retains caller custody, not proof of delivery: a
      // callback can throw after sending. Only its observer can prove no send.
      runParams.onBlockReply = async (payload, context) => {
        const messageIndex =
          context?.assistantMessageIndex ??
          getReplyPayloadMetadata(payload)?.assistantMessageIndex ??
          0;
        const retainsCustody =
          isReplyPayloadTerminalContent(payload) &&
          !isFastModeAutoProgressPayload(payload) &&
          resolveSendableOutboundReplyParts(payload).hasContent;
        if (!closed && retainsCustody && messageIndex >= minimumReplyMessageIndex) {
          legacyReplyCustodyIndex = Math.max(legacyReplyCustodyIndex, messageIndex);
        }
        await onBlockReply(payload, context);
      };
      runParams.resolveReplyDelivery = async (minimumAssistantMessageIndex = 0) => {
        minimumReplyMessageIndex = Math.max(minimumReplyMessageIndex, minimumAssistantMessageIndex);
        return !closed && legacyReplyCustodyIndex >= minimumReplyMessageIndex
          ? "pending"
          : "missing";
      };
    }
    const result = await runEmbeddedAgentCore({ ...runParams, config, preparedRunAdmission });
    if (admittedRunContext && getAdmittedRunDelegatedAuthority(admittedRunContext)) {
      recordRuntimeActionDecision({
        token: admittedRunContext.executionIdentityToken,
        family: "plugin",
        operation: "run",
        outcome: "allowed",
        coverageState: "attribution-only",
        reasonCode: "plugin_runtime_completed",
        owner: "plugin-runtime",
        decisionBoundary: "plugin.runtime.run-embedded-agent",
        summary: "The plugin-owned runtime completed; this is attribution, not authorization.",
        remediation: [],
        discriminator: JSON.stringify([pluginId, params.runId, decisionOccurrenceId, "completion"]),
      });
    }
    return result;
  } finally {
    params.abortSignal?.removeEventListener("abort", close);
    close();
  }
}
