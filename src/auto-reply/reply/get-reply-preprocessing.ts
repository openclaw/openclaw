// Optional utility preprocessing keeps its runtime loaders lazy and cancellation explicit.
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { readConversationBindingRouteFacts } from "../../channels/conversation-binding-route-facts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import { hasInboundAudio, hasInboundMediaForUnderstanding } from "./inbound-media.js";
import { assertReplyPreprocessingActive } from "./reply-preprocessing-abort.js";
import { assertPreparedConversationBindingRouteCurrent } from "./session-conversation-binding.js";

const mediaUnderstandingApplyRuntimeLoader = createLazyImportLoader(
  () => import("../../media-understanding/apply.runtime.js"),
);
const linkUnderstandingApplyRuntimeLoader = createLazyImportLoader(
  () => import("../../link-understanding/apply.runtime.js"),
);

export function hasLinkCandidate(ctx: MsgContext): boolean {
  const message = ctx.agentText;
  return Boolean(message && /\bhttps?:\/\/\S+/i.test(message));
}

export async function applyMediaUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  activeModel: { provider: string; model: string };
  modelSelectionLocked?: boolean;
  selfServeLocalPaths?: boolean;
  signal?: AbortSignal;
}): Promise<ApplyMediaUnderstandingResult | undefined> {
  if (!hasInboundMediaForUnderstanding(params.ctx)) {
    return undefined;
  }
  try {
    const { applyMediaUnderstanding } = await mediaUnderstandingApplyRuntimeLoader.load();
    assertReplyPreprocessingActive(params.signal);
    const { modelSelectionLocked, ...mediaParams } = params;
    const audio = params.cfg.tools?.media?.audio;
    return await applyMediaUnderstanding({
      ...mediaParams,
      ...(modelSelectionLocked
        ? {
            processingMode:
              hasInboundAudio(params.ctx) && audio !== undefined && audio.enabled !== false
                ? "audio-and-files"
                : "files-only",
          }
        : {}),
    });
  } catch (err) {
    assertReplyPreprocessingActive(params.signal);
    mediaUnderstandingApplyRuntimeLoader.clear();
    logVerbose(
      `media understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
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

/** Refuse a changed channel choice before preparing an agent's model or workspace. */
export async function resolveReplyAgentScope(params: { cfg: OpenClawConfig; ctx: MsgContext }) {
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
  return {
    agentSessionKey,
    agentId: resolveSessionAgentId({
      sessionKey: agentSessionKey,
      config: cfg,
      fallbackAgentId: ctx.AgentId,
    }),
  };
}
