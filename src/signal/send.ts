import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { mediaKindFromMime } from "../media/constants.js";
import { resolveOutboundAttachmentFromUrl } from "../media/outbound-attachment.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client.js";
import { markdownToSignalText, type SignalTextStyleRange } from "./format.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

export type SignalSendOpts = {
  baseUrl?: string;
  account?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  textMode?: "markdown" | "plain";
  textStyles?: SignalTextStyleRange[];
};

export type SignalSendResult = {
  messageId: string;
  timestamp?: number;
};

export type SignalRpcOpts = Pick<SignalSendOpts, "baseUrl" | "account" | "accountId" | "timeoutMs">;

export type SignalReceiptType = "read" | "viewed";

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

function parseTarget(raw: string): SignalTarget {
  let value = raw.trim();
  if (!value) {
    throw new Error("Signal recipient is required");
  }
  const lower = value.toLowerCase();
  if (lower.startsWith("signal:")) {
    value = value.slice("signal:".length).trim();
  }
  const normalized = value.toLowerCase();
  if (normalized.startsWith("group:")) {
    return { type: "group", groupId: value.slice("group:".length).trim() };
  }
  if (normalized.startsWith("username:")) {
    return {
      type: "username",
      username: value.slice("username:".length).trim(),
    };
  }
  if (normalized.startsWith("u:")) {
    return { type: "username", username: value.trim() };
  }
  return { type: "recipient", recipient: value };
}

type SignalTargetParams = {
  recipient?: string[];
  groupId?: string;
  username?: string[];
};

type SignalTargetAllowlist = {
  recipient?: boolean;
  group?: boolean;
  username?: boolean;
};

function buildTargetParams(
  target: SignalTarget,
  allow: SignalTargetAllowlist,
): SignalTargetParams | null {
  if (target.type === "recipient") {
    if (!allow.recipient) {
      return null;
    }
    return { recipient: [target.recipient] };
  }
  if (target.type === "group") {
    if (!allow.group) {
      return null;
    }
    return { groupId: target.groupId };
  }
  if (target.type === "username") {
    if (!allow.username) {
      return null;
    }
    return { username: [target.username] };
  }
  return null;
}

export async function sendMessageSignal(
  to: string,
  text: string,
  opts: SignalSendOpts = {},
): Promise<SignalSendResult> {
  const cfg = loadConfig();
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const target = parseTarget(to);
  let message = text ?? "";
  let messageFromPlaceholder = false;
  let textStyles: SignalTextStyleRange[] = [];
  const textMode = opts.textMode ?? "markdown";
  const maxBytes = (() => {
    if (typeof opts.maxBytes === "number") {
      return opts.maxBytes;
    }
    if (typeof accountInfo.config.mediaMaxMb === "number") {
      return accountInfo.config.mediaMaxMb * 1024 * 1024;
    }
    if (typeof cfg.agents?.defaults?.mediaMaxMb === "number") {
      return cfg.agents.defaults.mediaMaxMb * 1024 * 1024;
    }
    return 8 * 1024 * 1024;
  })();

  let attachments: string[] | undefined;
  if (opts.mediaUrl?.trim()) {
    const resolved = await resolveOutboundAttachmentFromUrl(opts.mediaUrl.trim(), maxBytes, {
      localRoots: opts.mediaLocalRoots,
    });
    attachments = [resolved.path];
    const kind = mediaKindFromMime(resolved.contentType ?? undefined);
    if (!message && kind) {
      // Avoid sending an empty body when only attachments exist.
      message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
      messageFromPlaceholder = true;
    }
  }

  if (message.trim() && !messageFromPlaceholder) {
    if (textMode === "plain") {
      textStyles = opts.textStyles ?? [];
    } else {
      const tableMode = resolveMarkdownTableMode({
        cfg,
        channel: "signal",
        accountId: accountInfo.accountId,
      });
      const formatted = markdownToSignalText(message, { tableMode });
      message = formatted.text;
      textStyles = formatted.styles;
    }
  }

  if (!message.trim() && (!attachments || attachments.length === 0)) {
    throw new Error("Signal send requires text or media");
  }

  const params: Record<string, unknown> = { message };
  if (textStyles.length > 0) {
    params["text-style"] = textStyles.map(
      (style) => `${style.start}:${style.length}:${style.style}`,
    );
  }
  if (account) {
    params.account = account;
  }
  if (attachments && attachments.length > 0) {
    params.attachments = attachments;
  }

  const targetParams = buildTargetParams(target, {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  Object.assign(params, targetParams);

  const result = await signalRpcRequest<{ timestamp?: number }>("send", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}

export async function sendTypingSignal(
  to: string,
  opts: SignalRpcOpts & { stop?: boolean } = {},
): Promise<boolean> {
  const { baseUrl, account } = resolveSignalRpcContext(opts);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = { ...targetParams };
  if (account) {
    params.account = account;
  }
  if (opts.stop) {
    params.stop = true;
  }
  await signalRpcRequest("sendTyping", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return true;
}

export async function sendReadReceiptSignal(
  to: string,
  targetTimestamp: number,
  opts: SignalRpcOpts & { type?: SignalReceiptType } = {},
): Promise<boolean> {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    return false;
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = {
    ...targetParams,
    targetTimestamp,
    type: opts.type ?? "read",
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequest("sendReceipt", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return true;
}

export async function sendRemoteDeleteSignal(
  to: string,
  targetTimestamp: number,
  opts: SignalRpcOpts = {},
): Promise<boolean> {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    return false;
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = {
    ...targetParams,
    targetTimestamp,
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequest("remoteDelete", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return true;
}

export type PollCreateOpts = SignalRpcOpts & {
  question: string;
  options: string[];
  allowMultiple?: boolean;
};

export async function sendPollCreateSignal(
  to: string,
  opts: PollCreateOpts,
): Promise<SignalSendResult> {
  if (!opts.question?.trim()) {
    throw new Error("Poll question is required");
  }
  if (!opts.options || opts.options.length < 2) {
    throw new Error("At least two poll options are required");
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Invalid poll create target");
  }
  const params: Record<string, unknown> = {
    ...targetParams,
    question: opts.question,
    option: opts.options,
    noMulti: !(opts.allowMultiple ?? true),
  };
  if (account) {
    params.account = account;
  }
  const result = await signalRpcRequest<{ timestamp?: number }>("sendPollCreate", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}

export type PollVoteOpts = SignalRpcOpts & {
  pollAuthor: string;
  pollTimestamp: number;
  optionIndexes: number[];
  voteCount?: number;
};

export async function sendPollVoteSignal(
  to: string,
  opts: PollVoteOpts,
): Promise<SignalSendResult> {
  if (!opts.pollAuthor?.trim()) {
    throw new Error("Poll author is required");
  }
  if (!Number.isFinite(opts.pollTimestamp) || opts.pollTimestamp <= 0) {
    throw new Error("Invalid poll timestamp");
  }
  if (!opts.optionIndexes || opts.optionIndexes.length === 0) {
    throw new Error("At least one poll option must be selected");
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Invalid poll vote target");
  }
  const params: Record<string, unknown> = {
    ...targetParams,
    pollAuthor: opts.pollAuthor,
    pollTimestamp: opts.pollTimestamp,
    option: opts.optionIndexes,
    voteCount: opts.voteCount ?? 1,
  };
  if (account) {
    params.account = account;
  }
  const result = await signalRpcRequest<{ timestamp?: number }>("sendPollVote", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}

export type PollTerminateOpts = SignalRpcOpts & {
  pollTimestamp: number;
};

export async function sendPollTerminateSignal(
  to: string,
  opts: PollTerminateOpts,
): Promise<SignalSendResult> {
  if (!Number.isFinite(opts.pollTimestamp) || opts.pollTimestamp <= 0) {
    throw new Error("Invalid poll timestamp");
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Invalid poll terminate target");
  }
  const params: Record<string, unknown> = {
    ...targetParams,
    pollTimestamp: opts.pollTimestamp,
    notifySelf: false,
  };
  if (account) {
    params.account = account;
  }
  const result = await signalRpcRequest<{ timestamp?: number }>("sendPollTerminate", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}
