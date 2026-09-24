import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import {
  resolveConversationCapabilityProfile,
  type ResolvedConversationCapabilityProfile,
} from "../../agents/conversation-capability-profile.js";
import { resolveConversationToolPolicies } from "../../agents/conversation-tool-policy-pipeline.js";
import { readOperatorModelPolicyMembership } from "../../agents/operator-model-policy.js";
import { resolveOwnerOnlyToolPolicy } from "../../agents/owner-tool-policy.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { isRuntimeToolAllowed, isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../agents/tool-policy.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { cloneConfigWithResolutionFacts } from "../../config/resolution-facts.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveDirectHumanRequesterProfileId } from "../command-owner-authority.js";
import type { RuntimeMsgContext } from "../templating.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { FollowupRun } from "./queue/types.js";
import type {
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRoute,
  ReplyToolAuthoritySnapshot,
} from "./reply-run-registry.contracts.js";

export type ReplyToolAuthorityInput = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  directHumanRequesterProfileId?: string;
  originatingChannel?: FollowupRun["originatingChannel"];
  toolsAllow?: string[];
  disableTools?: boolean;
  run: Partial<
    Pick<
      FollowupRun["run"],
      | "config"
      | "sessionId"
      | "sessionKey"
      | "runtimePolicySessionKey"
      | "agentId"
      | "agentDir"
      | "agentAccountId"
      | "provider"
      | "model"
      | "messageProvider"
      | "chatType"
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
      | "workspaceDir"
      | "cwd"
      | "inputProvenance"
      | "trustedInternalHandoff"
      | "scheduledToolPolicy"
      | "runtimePluginToolGrant"
      | "sessionFile"
      | "permissionMode"
      | "toolOverrides"
      | "execOverrides"
      | "elevatedLevel"
      | "bashElevated"
      | "traceAuthorized"
      | "approvalReviewerDeviceId"
      | "authProfileId"
      | "clientCaps"
      | "gatewayUiCommandTarget"
      | "toolBindings"
    >
  > &
    Pick<FollowupRun["run"], "sessionId" | "sessionFile" | "workspaceDir" | "provider" | "model">;
};

/** Projects current inbound facts against the active run's frozen authority snapshot. */
export function resolveInboundReplyToolAuthorityOverlay(params: {
  ctx: RuntimeMsgContext;
  sessionEntry?: Pick<SessionEntry, "permissionMode" | "spawnedBy" | "toolOverrides">;
  senderIsOwner: boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  toolsAllow?: string[];
  disableTools: boolean;
}): ReplyToolAuthorityOverlay {
  const { ctx } = params;
  return {
    operatorAuthority: params.operatorAuthority,
    directHumanRequesterProfileId: resolveDirectHumanRequesterProfileId(
      ctx,
      params.operatorAuthority,
    ),
    permissionMode: params.sessionEntry?.permissionMode,
    toolOverrides: params.sessionEntry?.toolOverrides,
    originatingChannel: ctx.OriginatingChannel,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: ctx.OriginatingChannel,
      provider: ctx.Provider ?? ctx.Surface,
    }),
    chatType: normalizeChatType(ctx.ChatType),
    agentAccountId: ctx.AccountId,
    conversationToolPolicy: ctx.ConversationToolPolicy,
    groupId: resolveGroupSessionKey(ctx)?.id,
    groupChannel:
      normalizeOptionalString(ctx.GroupChannel) ?? normalizeOptionalString(ctx.GroupSubject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    memberRoleIds: Array.isArray(ctx.MemberRoleIds)
      ? ctx.MemberRoleIds.map((roleId) => normalizeOptionalString(roleId)).filter(
          (roleId): roleId is string => Boolean(roleId),
        )
      : undefined,
    spawnedBy: normalizeOptionalString(params.sessionEntry?.spawnedBy),
    senderId: normalizeOptionalString(ctx.SenderId),
    senderName: normalizeOptionalString(ctx.SenderName),
    senderUsername: normalizeOptionalString(ctx.SenderUsername),
    senderE164: normalizeOptionalString(ctx.SenderE164),
    senderIsOwner: params.senderIsOwner,
    inputProvenance: ctx.InputProvenance,
    trustedInternalHandoff: undefined,
    scheduledToolPolicy: undefined,
    runtimePluginToolGrant: undefined,
    toolsAllow: params.toolsAllow,
    disableTools: params.disableTools,
    traceAuthorized:
      params.senderIsOwner || (ctx.GatewayClientScopes ?? []).includes("operator.admin"),
    approvalReviewerDeviceId: normalizeOptionalString(ctx.ApprovalReviewerDeviceId),
    clientCaps: ctx.GatewayClientCaps,
    gatewayUiCommandTarget: ctx.GatewayUiCommandTarget,
    toolBindings: ctx.GatewayRunToolBindings,
  };
}

function snapshotFollowupRunToolAuthority(run: ReplyToolAuthorityInput): ReplyToolAuthorityInput {
  const toolsAllow = run.toolsAllow ? [...run.toolsAllow] : undefined;
  const intersection = run.toolsAllow
    ? readToolAllowlistIntersection(run.toolsAllow)?.map((restriction) => restriction.slice())
    : undefined;
  if (toolsAllow && intersection) {
    attachToolAllowlistIntersection(toolsAllow, intersection);
  }
  return {
    originatingChannel: run.originatingChannel,
    operatorAuthority: run.operatorAuthority,
    directHumanRequesterProfileId: run.directHumanRequesterProfileId,
    toolsAllow,
    disableTools: run.disableTools === true,
    run: {
      ...run.run,
      config: run.run.config ? cloneConfigWithResolutionFacts(run.run.config) : undefined,
      conversationToolPolicy: structuredClone(run.run.conversationToolPolicy),
      inputProvenance: structuredClone(run.run.inputProvenance),
      scheduledToolPolicy: structuredClone(run.run.scheduledToolPolicy),
      runtimePluginToolGrant: structuredClone(run.run.runtimePluginToolGrant),
      trustedInternalHandoff: structuredClone(run.run.trustedInternalHandoff),
      toolOverrides: structuredClone(run.run.toolOverrides),
      execOverrides: structuredClone(run.run.execOverrides),
      bashElevated: structuredClone(run.run.bashElevated),
      toolBindings: structuredClone(run.run.toolBindings),
      clientCaps: run.run.clientCaps ? [...run.run.clientCaps] : undefined,
      gatewayUiCommandTarget: structuredClone(run.run.gatewayUiCommandTarget),
      memberRoleIds: run.run.memberRoleIds ? [...run.run.memberRoleIds] : undefined,
    },
  };
}

function applyReplyToolAuthorityOverlay(
  snapshot: ReplyToolAuthorityInput,
  overlay: ReplyToolAuthorityOverlay,
): ReplyToolAuthorityInput {
  return {
    ...snapshot,
    originatingChannel: overlay.originatingChannel,
    operatorAuthority: overlay.operatorAuthority,
    directHumanRequesterProfileId: overlay.directHumanRequesterProfileId,
    toolsAllow: overlay.toolsAllow,
    disableTools: overlay.disableTools,
    run: {
      ...snapshot.run,
      permissionMode: overlay.permissionMode,
      toolOverrides: overlay.toolOverrides,
      messageProvider: overlay.messageProvider,
      chatType: overlay.chatType,
      agentAccountId: overlay.agentAccountId,
      conversationToolPolicy: overlay.conversationToolPolicy,
      groupId: overlay.groupId,
      groupChannel: overlay.groupChannel,
      groupSpace: overlay.groupSpace,
      memberRoleIds: overlay.memberRoleIds,
      spawnedBy: overlay.spawnedBy,
      senderId: overlay.senderId,
      senderName: overlay.senderName,
      senderUsername: overlay.senderUsername,
      senderE164: overlay.senderE164,
      senderIsOwner: overlay.senderIsOwner,
      inputProvenance: overlay.inputProvenance,
      trustedInternalHandoff: overlay.trustedInternalHandoff,
      scheduledToolPolicy: overlay.scheduledToolPolicy,
      runtimePluginToolGrant: overlay.runtimePluginToolGrant,
      traceAuthorized: overlay.traceAuthorized,
      approvalReviewerDeviceId: overlay.approvalReviewerDeviceId,
      clientCaps: overlay.clientCaps,
      gatewayUiCommandTarget: overlay.gatewayUiCommandTarget,
      toolBindings: overlay.toolBindings,
    },
  };
}

function resolveReplyToolAuthorityContext(
  snapshot: ReplyToolAuthorityInput,
  route?: ReplyToolAuthorityRoute,
) {
  const execution = snapshot.run;
  const provider = route?.provider ?? execution.provider;
  const model = route?.model ?? execution.model;
  const policySessionKey = execution.runtimePolicySessionKey ?? execution.sessionKey;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: execution.config,
    agentId: execution.agentId,
    sessionKey: execution.sessionKey,
    classificationSessionKey: policySessionKey,
  });
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: execution.config,
    sessionId: execution.sessionId,
    // Capability identity follows execution, not the independent sandbox policy owner.
    sessionKey: execution.sessionKey,
    sandboxSessionKey: policySessionKey,
    agentId: execution.agentId,
    agentDir: execution.agentDir,
    agentAccountId: execution.agentAccountId,
    modelProvider: provider,
    modelId: model,
    messageProvider: execution.messageProvider,
    messageChannel: snapshot.originatingChannel,
    chatType: execution.chatType,
    conversationToolPolicy: execution.conversationToolPolicy,
    groupId: execution.groupId,
    groupChannel: execution.groupChannel,
    groupSpace: execution.groupSpace,
    memberRoleIds: execution.memberRoleIds,
    spawnedBy: execution.spawnedBy,
    senderId: execution.senderId,
    senderName: execution.senderName,
    senderUsername: execution.senderUsername,
    senderE164: execution.senderE164,
    senderIsOwner: execution.senderIsOwner,
    workspaceDir: execution.workspaceDir,
    cwd: execution.cwd,
    sandboxToolPolicy: sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined,
    inputProvenance: execution.inputProvenance,
    trustedInternalHandoff: execution.trustedInternalHandoff,
    scheduledToolPolicy: execution.scheduledToolPolicy,
    runtimePluginToolGrant: execution.runtimePluginToolGrant,
  });
  return { provider, model, capabilityProfile };
}

function isReplyToolAllowed(
  input: ReplyToolAuthorityInput,
  toolName: string,
  preparedProfile?: ResolvedConversationCapabilityProfile,
): boolean {
  if (input.disableTools === true || !isRuntimeToolAllowed(toolName, input.toolsAllow)) {
    return false;
  }
  const policies = resolveConversationToolPolicies({
    capabilityProfile: preparedProfile ?? resolveReplyToolAuthorityContext(input).capabilityProfile,
  });
  return isToolAllowedByPolicies(toolName, [
    ...Object.values(policies),
    resolveOwnerOnlyToolPolicy({
      senderIsOwner: input.run.senderIsOwner,
      operatorAuthority: input.operatorAuthority,
    }),
  ]);
}

/** Browser identity matters to admission only while this turn can control the UI. */
export function resolveReplyScreenToolTarget(
  input: ReplyToolAuthorityInput,
  preparedProfile?: ResolvedConversationCapabilityProfile,
) {
  return input.run.gatewayUiCommandTarget &&
    hasGatewayClientCap(input.run.clientCaps, GATEWAY_CLIENT_CAPS.UI_COMMANDS) &&
    isReplyToolAllowed(input, "screen", preparedProfile)
    ? input.run.gatewayUiCommandTarget
    : undefined;
}

/** Profile appearance remains requester-scoped even without browser control. */
export function resolveReplyThemeProfileId(
  input: ReplyToolAuthorityInput,
  preparedProfile?: ResolvedConversationCapabilityProfile,
): string | undefined {
  return input.run.gatewayUiCommandTarget?.profileId &&
    isReplyToolAllowed(input, "theme", preparedProfile)
    ? input.run.gatewayUiCommandTarget.profileId
    : undefined;
}

const operatorAuthorityIdentities = resolveGlobalSingleton(
  Symbol.for("openclaw.replyOperatorAuthorityIdentities"),
  () => ({ keys: new WeakMap<object, number>(), nextId: 1 }),
);

/** Compare original live owners without treating profile labels as authority. */
export function resolveReplyOperatorAuthorityKey(
  authority: AdmittedRunOperatorAuthority | undefined,
): string {
  if (!authority) {
    return "";
  }
  const identity = (value: object): number => {
    let key = operatorAuthorityIdentities.keys.get(value);
    if (key === undefined) {
      key = operatorAuthorityIdentities.nextId++;
      operatorAuthorityIdentities.keys.set(value, key);
    }
    return key;
  };
  return JSON.stringify([
    authority.profileId,
    [...new Set(authority.scopes.map((scope) => scope.trim()).filter(Boolean))].toSorted(),
    identity(authority.source ?? authority),
  ]);
}

function assertCurrentOperatorAuthority(authority: AdmittedRunOperatorAuthority | undefined): void {
  if (authority) {
    assertAdmittedRunOperatorAuthority(authority);
    authority.assertCurrent();
  }
}

function resolveReplyToolAuthorityInputFingerprint(
  snapshot: ReplyToolAuthorityInput,
  route?: ReplyToolAuthorityRoute,
): string {
  const execution = snapshot.run;
  const { provider, model, capabilityProfile } = resolveReplyToolAuthorityContext(snapshot, route);
  const authority = snapshot.operatorAuthority;
  assertCurrentOperatorAuthority(authority);
  const screenTarget = resolveReplyScreenToolTarget(snapshot, capabilityProfile);
  return createHash("sha256")
    .update(
      stableStringify({
        provider,
        model,
        policy: capabilityProfile.policy,
        operatorAuthority: authority
          ? {
              profileId: authority.profileId,
              scopes: [...new Set(authority.scopes)].toSorted(),
              gatewayAccessGrant:
                authority.gatewayAccessGrant === undefined
                  ? resolveReplyOperatorAuthorityKey(authority)
                  : authority.gatewayAccessGrant,
              modelPolicy:
                readOperatorModelPolicyMembership(authority.modelPolicy) ??
                resolveReplyOperatorAuthorityKey(authority),
            }
          : undefined,
        directHumanRequesterProfileId: snapshot.directHumanRequesterProfileId,
        toolsAllow: snapshot.toolsAllow,
        toolsAllowIntersection: snapshot.toolsAllow
          ? readToolAllowlistIntersection(snapshot.toolsAllow)
          : undefined,
        disableTools: snapshot.disableTools === true,
        sessionFile: execution.sessionFile,
        agentDir: execution.agentDir,
        workspaceDir: execution.workspaceDir,
        cwd: execution.cwd,
        permissionMode: execution.permissionMode,
        toolOverrides: execution.toolOverrides,
        execOverrides: execution.execOverrides,
        elevatedLevel: execution.elevatedLevel,
        bashElevated: execution.bashElevated,
        traceAuthorized: execution.traceAuthorized === true,
        authProfileId: execution.authProfileId,
        clientCaps: [...new Set(execution.clientCaps ?? [])].toSorted(),
        gatewayUiCommandTarget:
          authority && screenTarget?.profileId === authority.profileId
            ? { profileId: screenTarget.profileId }
            : screenTarget,
        themeProfileId: resolveReplyThemeProfileId(snapshot, capabilityProfile),
        toolBindings: execution.toolBindings,
      }),
    )
    .digest("hex");
}

/** Fingerprints the complete model-facing tool authority owned by one queued turn. */
export function resolveFollowupRunToolAuthorityFingerprint(
  run: ReplyToolAuthorityInput,
  route?: ReplyToolAuthorityRoute,
): string {
  return resolveReplyToolAuthorityInputFingerprint(snapshotFollowupRunToolAuthority(run), route);
}

/** Capture execution policy once; incoming overlays replace only caller-owned facts. */
export function prepareReplyToolAuthority(
  run: ReplyToolAuthorityInput,
  narrow?: (input: ReplyToolAuthorityInput) => ReplyToolAuthorityInput,
): ReplyToolAuthoritySnapshot {
  const snapshot = snapshotFollowupRunToolAuthority(run);
  return {
    fingerprint: (route) => resolveReplyToolAuthorityInputFingerprint(snapshot, route),
    project: (overlay, route) => {
      // Steering retains the running turn's authority and browser bindings across reconnects.
      assertCurrentOperatorAuthority(snapshot.operatorAuthority);
      const incoming = applyReplyToolAuthorityOverlay(snapshot, overlay);
      return resolveReplyToolAuthorityInputFingerprint(narrow ? narrow(incoming) : incoming, route);
    },
  };
}
