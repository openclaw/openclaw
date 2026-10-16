import { createQueueTestRun as createQueuedRun } from "./queue.test-helpers.js";
import type {
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRoute,
} from "./reply-run-registry.contracts.js";
import type { ReplyToolAuthorityInput } from "./reply-tool-authority-inbound.js";
import { prepareFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";

export async function resolveFollowupRunToolAuthorityFingerprintAsync(
  snapshot: ReplyToolAuthorityInput,
  route?: ReplyToolAuthorityRoute,
): Promise<string> {
  const prepared = await prepareFollowupRunToolAuthorityFingerprint(snapshot, route);
  try {
    return prepared.read();
  } finally {
    prepared.release();
  }
}

export function createQueueTestRun(params: Parameters<typeof createQueuedRun>[0]) {
  const run = createQueuedRun(params);
  run.run.messageProvider = "telegram";
  run.run.senderId = "alice";
  return run;
}

export function toolAuthorityOverlay(
  run: ReturnType<typeof createQueueTestRun>,
): ReplyToolAuthorityOverlay {
  return {
    sessionKey: run.run.sessionKey,
    operatorAuthority: run.operatorAuthority,
    permissionMode: run.run.permissionMode,
    toolOverrides: run.run.toolOverrides,
    originatingChannel: run.originatingChannel,
    messageProvider: run.run.messageProvider,
    chatType: run.run.chatType,
    agentAccountId: run.run.agentAccountId,
    conversationToolPolicy: run.run.conversationToolPolicy,
    conversationId: run.run.conversationId ?? undefined,
    messageThreadId: run.run.messageThreadId,
    groupId: run.run.groupId,
    groupChannel: run.run.groupChannel,
    groupSpace: run.run.groupSpace,
    memberRoleIds: run.run.memberRoleIds,
    spawnedBy: run.run.spawnedBy,
    senderId: run.run.senderId,
    senderName: run.run.senderName,
    senderUsername: run.run.senderUsername,
    senderE164: run.run.senderE164,
    senderIsOwner: run.run.senderIsOwner === true,
    inputProvenance: run.run.inputProvenance,
    trustedInternalHandoff: run.run.trustedInternalHandoff,
    scheduledToolPolicy: run.run.scheduledToolPolicy,
    runtimePluginToolGrant: run.run.runtimePluginToolGrant,
    toolsAllow: run.toolsAllow,
    disableTools: run.disableTools === true,
    traceAuthorized: run.run.traceAuthorized === true,
    approvalReviewerDeviceId: run.run.approvalReviewerDeviceId,
    clientCaps: run.run.clientCaps,
    gatewayUiCommandTarget: run.run.gatewayUiCommandTarget,
    toolBindings: run.run.toolBindings,
  };
}
