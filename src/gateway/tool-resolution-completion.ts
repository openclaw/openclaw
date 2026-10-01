import { hasVerifiedRequesterCompletionHandoff } from "../agents/requester-tool-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";

type CompletionGrantLineageParams = {
  cfg: OpenClawConfig;
  context: Pick<
    McpLoopbackRequestContext,
    | "sessionKey"
    | "runtimePolicySessionKey"
    | "sessionId"
    | "modelProvider"
    | "modelId"
    | "inputProvenance"
    | "trustedInternalHandoff"
  >;
};

/**
 * Whether a completion grant's requester lineage still verifies. Grants without a
 * handoff carry no lineage and are always current. The child entry can be removed or
 * re-parented while a tool call awaits preparation, hooks or approvals, so the tool
 * list, the dispatch authorization and the tool's source-effect guard all ask this.
 */
export function isCompletionGrantLineageCurrent(params: CompletionGrantLineageParams): boolean {
  const { context } = params;
  return (
    !context.trustedInternalHandoff ||
    hasVerifiedRequesterCompletionHandoff({
      config: params.cfg,
      sessionKey: context.runtimePolicySessionKey?.trim() || context.sessionKey,
      sessionId: context.sessionId,
      modelProvider: context.modelProvider,
      modelId: context.modelId,
      inputProvenance: context.inputProvenance,
      trustedInternalHandoff: context.trustedInternalHandoff,
    })
  );
}

/** Rejects a tool list, built or cached, whose completion grant outlived its lineage. */
export function assertCompletionGrantLineage(params: CompletionGrantLineageParams): void {
  if (!isCompletionGrantLineageCurrent(params)) {
    throw new Error("CLI completion tool grant no longer matches its requester policy");
  }
}
