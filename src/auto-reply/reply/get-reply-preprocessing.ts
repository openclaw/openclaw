import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
// Optional utility preprocessing keeps its runtime loaders lazy and cancellation explicit.
import type { ActiveMediaModel } from "../../../packages/media-understanding-common/src/active-model.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { prepareConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { projectConversationToolNames } from "../../agents/conversation-tool-policy-pipeline.js";
import { resolveSandboxRuntimeStatusAsync } from "../../agents/sandbox/runtime-status.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "../../agents/tool-fs-policy.js";
import { readConversationBindingRouteFacts } from "../../channels/conversation-binding-route-facts.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import { hasInboundMediaForUnderstanding } from "./inbound-media.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";
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
  activeModel: ActiveMediaModel;
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

/** Expose local attachment paths only when this request can actually read them. */
export async function canReadReplyAttachmentPaths(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  sessionCtx: MsgContext;
  workspaceDir: string;
  stagedAttachmentCount: number;
  spawnedBy?: string;
  sessionEntry: SessionEntry;
  senderIsOwner: boolean;
  modelProvider: string;
  modelId: string;
  operatorProfileId?: string;
  toolsAllow?: string[];
}): Promise<boolean> {
  const {
    cfg,
    agentId,
    sessionKey,
    sessionCtx,
    workspaceDir,
    stagedAttachmentCount,
    spawnedBy,
    senderIsOwner,
    modelProvider,
    modelId,
    operatorProfileId,
    toolsAllow,
  } = params;
  const policySessionKey = resolveRuntimePolicySessionKey({
    cfg,
    agentId,
    ctx: sessionCtx,
    sessionKey,
  });
  const sandboxed = (
    await resolveSandboxRuntimeStatusAsync({
      cfg,
      agentId,
      sessionKey,
      classificationSessionKey: policySessionKey,
      ...(policySessionKey === sessionKey ? { preparedSessionEntry: params.sessionEntry } : {}),
    })
  ).sandboxed;
  if (
    (sandboxed && stagedAttachmentCount > 0) ||
    (!sandboxed && resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId }))
  ) {
    const capabilityProfile = await prepareConversationCapabilityProfile({
      config: cfg,
      sessionKey: policySessionKey,
      runSessionKey: policySessionKey === sessionKey ? undefined : sessionKey,
      agentId,
      agentAccountId: sessionCtx.AccountId,
      messageProvider: resolveOriginMessageProvider({
        originatingChannel: sessionCtx.OriginatingChannel,
        provider: sessionCtx.Provider ?? sessionCtx.Surface,
      }),
      conversationToolPolicy: sessionCtx.ConversationToolPolicy,
      conversationId: sessionCtx.ChatId,
      chatType: sessionCtx.ChatType,
      messageThreadId: sessionCtx.MessageThreadId,
      memberRoleIds: sessionCtx.MemberRoleIds,
      operatorProfileId,
      groupId: resolveGroupSessionKey(sessionCtx)?.id,
      groupChannel:
        normalizeOptionalString(sessionCtx.GroupChannel) ??
        normalizeOptionalString(sessionCtx.GroupSubject),
      groupSpace: normalizeOptionalString(sessionCtx.GroupSpace),
      spawnedBy: normalizeOptionalString(spawnedBy),
      senderId: normalizeOptionalString(sessionCtx.SenderId),
      senderName: normalizeOptionalString(sessionCtx.SenderName),
      senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
      senderE164: normalizeOptionalString(sessionCtx.SenderE164),
      senderIsOwner,
      modelProvider,
      modelId,
      workspaceDir,
      runtimeToolAllowlist: toolsAllow,
      inheritRuntimeToolAllowlist: true,
      inputProvenance: sessionCtx.InputProvenance,
    });
    return (
      projectConversationToolNames({ capabilityProfile, toolNames: ["read"], warn: () => {} })
        .length === 1
    );
  }
  return false;
}
