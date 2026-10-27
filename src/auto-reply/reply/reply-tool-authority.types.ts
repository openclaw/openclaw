import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { FollowupRun } from "./queue/types.js";

export type ReplyToolAuthorityInput = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  originatingChannel?: FollowupRun["originatingChannel"];
  toolsAllow?: string[];
  disableTools?: boolean;
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
  run: Partial<
    Pick<
      FollowupRun["run"],
      | "config"
      | "sessionKey"
      | "runtimePolicySessionKey"
      | "agentId"
      | "agentDir"
      | "agentAccountId"
      | "messageProvider"
      | "chatType"
      | "requesterOrigin"
      | "conversationId"
      | "messageThreadId"
      | "conversationToolPolicy"
      | "groupId"
      | "groupChannel"
      | "groupSpace"
      | "memberRoleIds"
      | "spawnedBy"
      | "senderId"
      | "senderName"
      | "senderUsername"
      | "senderE164"
      | "senderIsOwner"
      | "gitContributorProfileId"
      | "cwd"
      | "inputProvenance"
      | "trustedInternalHandoff"
      | "scheduledToolPolicy"
      | "runtimePluginToolGrant"
      | "permissionMode"
      | "toolOverrides"
      | "execOverrides"
      | "elevatedLevel"
      | "bashElevated"
      | "traceAuthorized"
      | "approvalReviewerDeviceId"
      | "authProfileId"
      | "authProfileIdSource"
      | "clientCaps"
      | "gatewayUiCommandTarget"
      | "toolBindings"
    >
  > & { operatorProfileId?: string } & Pick<
      FollowupRun["run"],
      "sessionId" | "sessionFile" | "workspaceDir" | "provider" | "model"
    >;
};
