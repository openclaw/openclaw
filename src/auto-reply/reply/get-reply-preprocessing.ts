// Optional utility preprocessing keeps its runtime loaders lazy and cancellation explicit.
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { readConversationBindingRouteFacts } from "../../channels/conversation-binding-route-facts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { createAbortError, isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { FinalizedRuntimeMsgContext, RuntimeMsgContext as MsgContext } from "../templating.js";
import { hasInboundMediaForUnderstanding } from "./inbound-media.js";
import { assertPreparedConversationBindingRouteCurrent } from "./session-conversation-binding.js";

const mediaUnderstandingApplyRuntimeLoader = createLazyImportLoader(
  () => import("../../media-understanding/apply.runtime.js"),
);
const linkUnderstandingApplyRuntimeLoader = createLazyImportLoader(
  () => import("../../link-understanding/apply.runtime.js"),
);

export function hasLinkCandidate(ctx: MsgContext): boolean {
  const message = ctx.agentText;
  if (!message) {
    return false;
  }
  return /\bhttps?:\/\/\S+/i.test(message);
}

export async function applyMediaUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  activeModel: { provider: string; model: string };
  processingMode?: "audio-only" | "files-only" | "audio-and-files";
  selfServeLocalPaths?: boolean;
}): Promise<ApplyMediaUnderstandingResult | undefined> {
  if (!hasInboundMediaForUnderstanding(params.ctx)) {
    return undefined;
  }
  try {
    const { applyMediaUnderstanding } = await mediaUnderstandingApplyRuntimeLoader.load();
    return await applyMediaUnderstanding(params);
  } catch (err) {
    mediaUnderstandingApplyRuntimeLoader.clear();
    logVerbose(
      `media understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

export function hasExplicitAudioUnderstandingConfig(cfg: OpenClawConfig): boolean {
  const audio = cfg.tools?.media?.audio;
  return audio !== undefined && audio.enabled !== false;
}

export async function applyLinkUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!hasLinkCandidate(params.ctx)) {
    return false;
  }
  try {
    const { applyLinkUnderstanding } = await linkUnderstandingApplyRuntimeLoader.load();
    await applyLinkUnderstanding(params);
    return true;
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    linkUnderstandingApplyRuntimeLoader.clear();
    logVerbose(
      `link understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
    );
    return false;
  }
}

export function assertReplyPreprocessingActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError("Reply canceled during preprocessing", { cause: signal.reason });
  }
}

/** Refuse a changed channel choice before preparing an agent's model or workspace. */
export async function resolveReplyAgentScope(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedRuntimeMsgContext;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}) {
  const { cfg, ctx } = params;
  const targetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
  if (
    readConversationBindingRouteFacts(ctx) &&
    ctx.InternalTurnSource === undefined &&
    !targetSessionKey
  ) {
    await assertPreparedConversationBindingRouteCurrent(ctx);
  }
  const agentSessionKey = targetSessionKey || ctx.SessionKey;
  const scope = {
    agentSessionKey,
    agentId: resolveSessionAgentId({
      sessionKey: agentSessionKey,
      config: cfg,
      fallbackAgentId: ctx.AgentId,
    }),
  };
  if (params.operatorAuthority?.requesterChannelIdentity) {
    const { resolveReplySessionPreprocessingState } = await import("./session.js");
    const existing = await resolveReplySessionPreprocessingState({ ctx, cfg });
    params.operatorAuthority.assertSessionAllowed?.({
      agentId: scope.agentId,
      sessionKey: existing.sessionKey,
      sandbox: existing.sessionEntry?.sandbox,
    });
  }
  return scope;
}
