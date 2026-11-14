import type { FollowupRun } from "./queue/types.js";

export function buildReplyMediaContextParams(
  { run, originatingAccountId }: FollowupRun,
  sessionKey: string | undefined,
  cfg: FollowupRun["run"]["config"],
) {
  return {
    cfg,
    agentId: run.agentId,
    sessionKey,
    workspaceDir: run.workspaceDir,
    mediaNormalizationOwner: run.mediaNormalizationOwner,
    messageProvider: run.messageProvider,
    accountId: originatingAccountId ?? run.agentAccountId,
    groupId: run.groupId,
    groupChannel: run.groupChannel,
    groupSpace: run.groupSpace,
    requesterSenderId: run.senderId,
    requesterSenderName: run.senderName,
    requesterSenderUsername: run.senderUsername,
    requesterSenderE164: run.senderE164,
  };
}
