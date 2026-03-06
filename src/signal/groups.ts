import { loadConfig } from "../config/config.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client.js";
import { listSignalGroups, type SignalDirectoryOpts, type SignalGroupMember } from "./directory.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

function normalizeSignalGroupId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/^signal:group:/i, "")
    .replace(/^group:/i, "")
    .trim();
}

function normalizeSignalMemberIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) {
    return "";
  }
  if (withoutSignal.toLowerCase().startsWith("uuid:")) {
    return withoutSignal.slice("uuid:".length).trim();
  }
  return withoutSignal;
}

export type SignalGroupUpdate = {
  name?: string;
  addMembers?: string[];
  removeMembers?: string[];
};

export async function listGroupMembersSignal(
  groupId: string,
  opts: SignalDirectoryOpts = {},
): Promise<SignalGroupMember[]> {
  const normalizedGroupId = normalizeSignalGroupId(groupId);
  if (!normalizedGroupId) {
    throw new Error("Signal listGroupMembers requires groupId");
  }
  const groups = await listSignalGroups(opts, { detailed: true });
  const group = groups.find((entry) => entry.id?.trim() === normalizedGroupId);
  if (!group) {
    return [];
  }
  return Array.isArray(group.members) ? group.members : [];
}

export async function updateGroupSignal(
  groupId: string,
  update: SignalGroupUpdate,
  opts: SignalDirectoryOpts = {},
): Promise<void> {
  const normalizedGroupId = normalizeSignalGroupId(groupId);
  if (!normalizedGroupId) {
    throw new Error("Signal updateGroup requires groupId");
  }

  const normalizedName = update.name?.trim();
  const addMembers = (update.addMembers ?? [])
    .map((entry) => normalizeSignalMemberIdentifier(entry))
    .filter(Boolean);
  const removeMembers = (update.removeMembers ?? [])
    .map((entry) => normalizeSignalMemberIdentifier(entry))
    .filter(Boolean);
  if (!normalizedName && addMembers.length === 0 && removeMembers.length === 0) {
    throw new Error("Signal updateGroup requires at least one change");
  }

  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const params: Record<string, unknown> = {
    groupId: normalizedGroupId,
    ...(normalizedName ? { name: normalizedName } : {}),
    ...(addMembers.length > 0 ? { addMembers } : {}),
    ...(removeMembers.length > 0 ? { removeMembers } : {}),
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequest("updateGroup", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function addGroupMemberSignal(
  groupId: string,
  member: string,
  opts: SignalDirectoryOpts = {},
): Promise<void> {
  const normalizedMember = normalizeSignalMemberIdentifier(member);
  if (!normalizedMember) {
    throw new Error("Signal addGroupMember requires member");
  }
  await updateGroupSignal(
    groupId,
    {
      addMembers: [normalizedMember],
    },
    opts,
  );
}

export async function removeGroupMemberSignal(
  groupId: string,
  member: string,
  opts: SignalDirectoryOpts = {},
): Promise<void> {
  const normalizedMember = normalizeSignalMemberIdentifier(member);
  if (!normalizedMember) {
    throw new Error("Signal removeGroupMember requires member");
  }
  await updateGroupSignal(
    groupId,
    {
      removeMembers: [normalizedMember],
    },
    opts,
  );
}

export async function joinGroupSignal(uri: string, opts: SignalDirectoryOpts = {}): Promise<void> {
  const normalizedUri = uri.trim();
  if (!normalizedUri) {
    throw new Error("Signal joinGroup requires uri");
  }
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const params: Record<string, unknown> = {
    uri: normalizedUri,
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequest("joinGroup", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function quitGroupSignal(
  groupId: string,
  opts: SignalDirectoryOpts = {},
): Promise<void> {
  const normalizedGroupId = normalizeSignalGroupId(groupId);
  if (!normalizedGroupId) {
    throw new Error("Signal quitGroup requires groupId");
  }
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const params: Record<string, unknown> = {
    groupId: normalizedGroupId,
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequest("quitGroup", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
}
