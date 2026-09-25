import type { CompactEmbeddedAgentSessionParams } from "../../agents/embedded-agent-runner/compact.types.js";
import { resolvePersistedSessionRuntimeId } from "../../agents/session-runtime-compat.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FollowupRun } from "./queue.js";

/** Budget-preflight arguments for embedded compaction, including the originating client. */
export function buildPreflightCompactSessionParams(input: {
  entry: SessionEntry;
  run: FollowupRun["run"];
  cfg: OpenClawConfig;
  agentHarnessId?: string;
  runtimeId: string;
  runtimePolicySessionKey?: string;
  compactionSessionKey: string;
  compactionTarget: {
    agentId: string;
    sessionKey: string;
    storePath?: string;
  };
  compactionTrigger: "tokens" | "transcript_bytes";
  contextWindowTokens: number;
  currentTokenCount: number | undefined;
  abortSignal?: AbortSignal;
}): CompactEmbeddedAgentSessionParams {
  const { entry, run } = input;
  return {
    sessionId: entry.sessionId,
    sessionKey: input.compactionSessionKey,
    sessionTarget: { ...input.compactionTarget, sessionId: entry.sessionId },
    sandboxSessionKey: input.runtimePolicySessionKey,
    allowGatewaySubagentBinding: true,
    messageChannel: run.messageProvider,
    clientCaps: run.clientCaps,
    ...(run.clientId ? { clientId: run.clientId } : {}),
    conversationToolPolicy: run.conversationToolPolicy,
    groupId: entry.groupId ?? run.groupId,
    groupChannel: entry.groupChannel ?? run.groupChannel,
    groupSpace: entry.space ?? run.groupSpace,
    senderId: run.senderId,
    senderName: run.senderName,
    senderUsername: run.senderUsername,
    senderE164: run.senderE164,
    inputProvenance: run.inputProvenance,
    sessionFile: input.compactionSessionKey,
    workspaceDir: run.workspaceDir,
    cwd: run.cwd,
    agentDir: run.agentDir,
    config: input.cfg,
    // Group session keys do not encode account identity, so without this the
    // preflight path resolves the root history limit after prompt preparation
    // already used the account limit.
    agentAccountId: run.agentAccountId,
    conversationRoutePeerId: run.conversationRoutePeerId,
    chatType: run.chatType,
    skillsSnapshot: entry.skillsSnapshot ?? run.skillsSnapshot,
    provider: run.provider,
    model: run.model,
    authProfileId: run.authProfileId,
    authProfileIdSource: run.authProfileIdSource,
    sessionEntry: entry,
    agentHarnessId:
      input.agentHarnessId ??
      (entry.sessionId === run.sessionId
        ? entry.modelSelectionLocked === true
          ? resolvePersistedSessionRuntimeId(entry)
          : input.runtimeId
        : undefined),
    modelSelectionLocked: entry.modelSelectionLocked === true,
    thinkLevel: run.thinkLevel,
    bashElevated: run.bashElevated,
    trigger: "budget",
    force: true,
    forcePreflight: true,
    preflightRequired: true,
    preflightCompactionTrigger: input.compactionTrigger,
    deferOwningContextEngineCompaction: false,
    contextTokenBudget: input.contextWindowTokens,
    currentTokenCount: input.currentTokenCount,
    ownerNumbers: run.ownerNumbers,
    abortSignal: input.abortSignal,
  };
}
