import { loadConfig } from "../config/config.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client.js";
import { resolveSignalRpcContext } from "./rpc-context.js";
import type { SignalRpcOpts } from "./send.js";

export type SignalDirectoryOpts = SignalRpcOpts;

export type SignalContact = {
  name?: string | null;
  number?: string | null;
  uuid?: string | null;
  [key: string]: unknown;
};

export type SignalGroupMember = {
  name?: string | null;
  number?: string | null;
  uuid?: string | null;
  [key: string]: unknown;
};

export type SignalGroup = {
  id?: string | null;
  name?: string | null;
  members?: SignalGroupMember[] | null;
  [key: string]: unknown;
};

function normalizeSignalDirectoryIdentifier(raw: string): string {
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

export async function listSignalGroups(
  opts: SignalDirectoryOpts = {},
  params: { detailed?: boolean } = {},
): Promise<SignalGroup[]> {
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const rpcParams: Record<string, unknown> = {};
  if (params.detailed === true) {
    rpcParams.detailed = true;
  }
  if (account) {
    rpcParams.account = account;
  }
  const result = await signalRpcRequest("listGroups", rpcParams, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return Array.isArray(result) ? (result as SignalGroup[]) : [];
}

export async function listSignalContacts(opts: SignalDirectoryOpts = {}): Promise<SignalContact[]> {
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const rpcParams: Record<string, unknown> = {};
  if (account) {
    rpcParams.account = account;
  }
  const result = await signalRpcRequest("listContacts", rpcParams, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return Array.isArray(result) ? (result as SignalContact[]) : [];
}

export async function updateContactSignal(
  recipient: string,
  name: string,
  opts: SignalDirectoryOpts = {},
): Promise<void> {
  const normalizedRecipient = normalizeSignalDirectoryIdentifier(recipient);
  if (!normalizedRecipient) {
    throw new Error("Signal update contact requires recipient");
  }
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error("Signal update contact requires name");
  }
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const params: Record<string, unknown> = {
    recipient: normalizedRecipient,
    name: normalizedName,
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequest("updateContact", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
}
