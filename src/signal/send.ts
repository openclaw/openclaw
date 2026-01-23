import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { mediaKindFromMime } from "../media/constants.js";
import { saveMediaBuffer } from "../media/store.js";
import { loadWebMedia } from "../web/media.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client.js";
import { markdownToSignalText, type SignalTextStyleRange } from "./format.js";

export type SignalSendOpts = {
  baseUrl?: string;
  account?: string;
  accountId?: string;
  mediaUrl?: string;
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
  if (!value) throw new Error("Signal recipient is required");
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
    if (!allow.recipient) return null;
    return { recipient: [target.recipient] };
  }
  if (target.type === "group") {
    if (!allow.group) return null;
    return { groupId: target.groupId };
  }
  if (target.type === "username") {
    if (!allow.username) return null;
    return { username: [target.username] };
  }
  return null;
}

function resolveSignalRpcContext(
  opts: SignalRpcOpts,
  accountInfo?: ReturnType<typeof resolveSignalAccount>,
) {
  const hasBaseUrl = Boolean(opts.baseUrl?.trim());
  const hasAccount = Boolean(opts.account?.trim());
  const resolvedAccount =
    accountInfo ||
    (!hasBaseUrl || !hasAccount
      ? resolveSignalAccount({
          cfg: loadConfig(),
          accountId: opts.accountId,
        })
      : undefined);
  const baseUrl = opts.baseUrl?.trim() || resolvedAccount?.baseUrl;
  if (!baseUrl) {
    throw new Error("Signal base URL is required");
  }
  const account = opts.account?.trim() || resolvedAccount?.config.account?.trim();
  return { baseUrl, account };
}

async function resolveAttachment(
  mediaUrl: string,
  maxBytes: number,
): Promise<{ path: string; contentType?: string }> {
  const media = await loadWebMedia(mediaUrl, maxBytes);
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
  );
  return { path: saved.path, contentType: saved.contentType };
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
    if (typeof opts.maxBytes === "number") return opts.maxBytes;
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
    const resolved = await resolveAttachment(opts.mediaUrl.trim(), maxBytes);
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
  if (account) params.account = account;
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
  if (!targetParams) return false;
  const params: Record<string, unknown> = { ...targetParams };
  if (account) params.account = account;
  if (opts.stop) params.stop = true;
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
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) return false;
  const { baseUrl, account } = resolveSignalRpcContext(opts);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
  });
  if (!targetParams) return false;
  const params: Record<string, unknown> = {
    ...targetParams,
    targetTimestamp,
    type: opts.type ?? "read",
  };
  if (account) params.account = account;
  await signalRpcRequest("sendReceipt", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return true;
}
