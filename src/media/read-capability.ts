// Media read capability helpers gate file reads by configured media access rules.
import path from "node:path";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolvePathFromInput } from "../agents/path-policy.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "../agents/tool-fs-policy.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import { resolveChannelGroupToolsPolicy } from "../config/group-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLocalFileSafely } from "../infra/fs-safe.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import type { OutboundMediaAccess, OutboundMediaReadFile } from "./load-options.js";
import {
  getAgentScopedMediaLocalRoots,
  getAgentScopedMediaLocalRootsForSources,
} from "./local-roots.js";

type OutboundHostMediaPolicyContext = {
  sessionKey?: string;
  messageProvider?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
  requesterSenderId?: string | null;
  requesterSenderName?: string | null;
  requesterSenderUsername?: string | null;
  requesterSenderE164?: string | null;
};

function collectUniqueStrings(values: Array<string | null | undefined>): string[] {
  return normalizeUniqueSingleOrTrimmedStringList(values);
}

function buildScopedGroupIdCandidates(groupId?: string | null): string[] {
  const raw = groupId?.trim();
  if (!raw) {
    return [];
  }
  const topicSenderMatch = raw.match(/^(.+):topic:([^:]+):sender:([^:]+)$/i);
  if (topicSenderMatch) {
    const [, chatId, topicId] = topicSenderMatch;
    return collectUniqueStrings([raw, `${chatId}:topic:${topicId}`, chatId]);
  }
  const topicMatch = raw.match(/^(.+):topic:([^:]+)$/i);
  if (topicMatch) {
    const [, chatId, topicId] = topicMatch;
    return collectUniqueStrings([`${chatId}:topic:${topicId}`, chatId]);
  }
  const senderMatch = raw.match(/^(.+):sender:([^:]+)$/i);
  if (senderMatch) {
    const [, chatId] = senderMatch;
    return collectUniqueStrings([raw, chatId]);
  }
  return [raw];
}

function resolveGroupContextFromSessionKey(sessionKey?: string | null): {
  channel?: string;
  groupIds?: string[];
} {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return {};
  }
  const baseSessionKey = raw.split(":thread:")[0] ?? raw;
  const parts = baseSessionKey.split(":").filter(Boolean);
  let body = parts[0] === "agent" ? parts.slice(2) : parts;
  if (body[0] === "subagent") {
    body = body.slice(1);
  }
  if (body.length < 3) {
    return {};
  }
  const [channel, kind, ...rest] = body;
  if (kind !== "group" && kind !== "channel") {
    return {};
  }
  const groupId = rest.join(":").trim();
  if (!groupId) {
    return {};
  }
  return {
    channel: normalizeMessageChannel(channel),
    groupIds: buildScopedGroupIdCandidates(groupId),
  };
}

function resolveHostMediaGroupToolPolicy(
  params: {
    cfg: OpenClawConfig;
  } & OutboundHostMediaPolicyContext,
) {
  const sessionContext = resolveGroupContextFromSessionKey(params.sessionKey);
  const groupIds = collectUniqueStrings([
    ...(sessionContext.groupIds ?? []),
    ...buildScopedGroupIdCandidates(params.groupId),
  ]);
  const channel = normalizeMessageChannel(sessionContext.channel ?? params.messageProvider);
  if (!channel || groupIds.length === 0) {
    return undefined;
  }
  return resolveChannelGroupToolsPolicy({
    cfg: params.cfg,
    channel,
    messageProvider: channel,
    groupId: groupIds[0],
    groupIdCandidates: groupIds.slice(1),
    accountId: params.accountId,
    senderId: params.requesterSenderId,
    senderName: params.requesterSenderName,
    senderUsername: params.requesterSenderUsername,
    senderE164: params.requesterSenderE164,
  });
}

function isAgentScopedHostMediaReadAllowed(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
  } & OutboundHostMediaPolicyContext,
): boolean {
  if (
    !resolveEffectiveToolFsRootExpansionAllowed({
      cfg: params.cfg,
      agentId: params.agentId,
    })
  ) {
    return false;
  }
  const groupPolicy = resolveHostMediaGroupToolPolicy({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    accountId: params.accountId,
    requesterSenderId: params.requesterSenderId,
    requesterSenderName: params.requesterSenderName,
    requesterSenderUsername: params.requesterSenderUsername,
    requesterSenderE164: params.requesterSenderE164,
  });
  // Sender/group policy only applies when a concrete group override exists.
  if (groupPolicy && !isToolAllowedByPolicies("read", [groupPolicy])) {
    return false;
  }
  return true;
}

/** Creates a host reader bound to the agent workspace and configured local-file safety checks. */
export function createAgentScopedHostMediaReadFile(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    workspaceDir?: string;
  } & OutboundHostMediaPolicyContext,
): OutboundMediaReadFile | undefined {
  if (!isAgentScopedHostMediaReadAllowed(params)) {
    return undefined;
  }
  const inferredWorkspaceDir =
    params.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const workspaceRoot = resolveWorkspaceRoot(inferredWorkspaceDir);
  return async (filePath: string) => {
    const resolvedPath = resolvePathFromInput(filePath, workspaceRoot);
    return (await readLocalFileSafely({ filePath: resolvedPath })).buffer;
  };
}

function appendWorkspaceDirToLocalRoots(
  roots: readonly string[] | undefined,
  workspaceDir?: string,
): readonly string[] | undefined {
  if (!workspaceDir) {
    return roots;
  }
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  if (!roots?.length) {
    return [resolvedWorkspaceDir];
  }
  if (roots.some((root) => path.resolve(root) === resolvedWorkspaceDir)) {
    return roots;
  }
  return [...roots, resolvedWorkspaceDir];
}

/** Resolves roots and optional host read capability for outbound media in an agent context. */
export function resolveAgentScopedOutboundMediaAccess(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    mediaSources?: readonly string[];
    workspaceDir?: string;
    mediaAccess?: OutboundMediaAccess;
    mediaReadFile?: OutboundMediaReadFile;
  } & OutboundHostMediaPolicyContext,
): OutboundMediaAccess {
  const resolvedWorkspaceDir =
    params.workspaceDir ??
    params.mediaAccess?.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const hostMediaReadAllowed = isAgentScopedHostMediaReadAllowed(params);
  // Even when host reads are denied, keep base roots so generated media remains addressable.
  const baseLocalRoots =
    params.mediaAccess?.localRoots ??
    (hostMediaReadAllowed
      ? getAgentScopedMediaLocalRootsForSources({
          cfg: params.cfg,
          agentId: params.agentId,
          mediaSources: params.mediaSources,
        })
      : getAgentScopedMediaLocalRoots(params.cfg, params.agentId));
  const localRoots = appendWorkspaceDirToLocalRoots(baseLocalRoots, resolvedWorkspaceDir);
  const readFile =
    params.mediaAccess?.readFile ??
    params.mediaReadFile ??
    (hostMediaReadAllowed
      ? createAgentScopedHostMediaReadFile({
          cfg: params.cfg,
          agentId: params.agentId,
          workspaceDir: resolvedWorkspaceDir,
          sessionKey: params.sessionKey,
          messageProvider: params.messageProvider,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          accountId: params.accountId,
          requesterSenderId: params.requesterSenderId,
          requesterSenderName: params.requesterSenderName,
          requesterSenderUsername: params.requesterSenderUsername,
          requesterSenderE164: params.requesterSenderE164,
        })
      : undefined);
  return {
    ...(localRoots?.length ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
    ...(resolvedWorkspaceDir ? { workspaceDir: resolvedWorkspaceDir } : {}),
  };
}
