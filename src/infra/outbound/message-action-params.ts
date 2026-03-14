import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSlackTarget } from "../../../extensions/slack/src/targets.js";
import { parseTelegramTarget } from "../../../extensions/telegram/src/targets.js";
import { loadWebMedia } from "../../../extensions/whatsapp/src/media.js";
import { assertMediaNotDataUrl, resolveSandboxedMediaSource } from "../../agents/sandbox-paths.js";
import { readStringParam } from "../../agents/tools/common.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createRootScopedReadFile } from "../../infra/fs-safe.js";
import { extensionForMime } from "../../media/mime.js";
import { readBooleanParam as readBooleanParamShared } from "../../plugin-sdk/boolean-param.js";

export const readBooleanParam = readBooleanParamShared;

export function resolveSlackAutoThreadId(params: {
  to: string;
  toolContext?: ChannelThreadingToolContext;
}): string | undefined {
  const context = params.toolContext;
  if (!context?.currentThreadTs || !context.currentChannelId) {
    return undefined;
  }
  // Only mirror auto-threading when Slack would reply in the active thread for this channel.
  if (context.replyToMode !== "all" && context.replyToMode !== "first") {
    return undefined;
  }
  const parsedTarget = parseSlackTarget(params.to, { defaultKind: "channel" });
  if (!parsedTarget || parsedTarget.kind !== "channel") {
    return undefined;
  }
  if (parsedTarget.id.toLowerCase() !== context.currentChannelId.toLowerCase()) {
    return undefined;
  }
  if (context.replyToMode === "first" && context.hasRepliedRef?.value) {
    return undefined;
  }
  return context.currentThreadTs;
}

/**
 * Auto-inject Telegram forum topic thread ID when the message tool targets
 * the same chat the session originated from.  Mirrors the Slack auto-threading
 * pattern so media, buttons, and other tool-sent messages land in the correct
 * topic instead of the General Topic.
 *
 * Unlike Slack, we do not gate on `replyToMode` here: Telegram forum topics
 * are persistent sub-channels (not ephemeral reply threads), so auto-injection
 * should always apply when the target chat matches.
 */
export function resolveTelegramAutoThreadId(params: {
  to: string;
  toolContext?: ChannelThreadingToolContext;
}): string | undefined {
  const context = params.toolContext;
  if (!context?.currentThreadTs || !context.currentChannelId) {
    return undefined;
  }
  // Use parseTelegramTarget to extract canonical chatId from both sides,
  // mirroring how Slack uses parseSlackTarget. This handles format variations
  // like `telegram:group:123:topic:456` vs `telegram:123`.
  const parsedTo = parseTelegramTarget(params.to);
  const parsedChannel = parseTelegramTarget(context.currentChannelId);
  if (parsedTo.chatId.toLowerCase() !== parsedChannel.chatId.toLowerCase()) {
    return undefined;
  }
  return context.currentThreadTs;
}

function resolveAttachmentMaxBytes(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
}): number | undefined {
  const accountId = typeof params.accountId === "string" ? params.accountId.trim() : "";
  const channelCfg = params.cfg.channels?.[params.channel];
  const channelObj =
    channelCfg && typeof channelCfg === "object"
      ? (channelCfg as Record<string, unknown>)
      : undefined;
  const channelMediaMax =
    typeof channelObj?.mediaMaxMb === "number" ? channelObj.mediaMaxMb : undefined;
  const accountsObj =
    channelObj?.accounts && typeof channelObj.accounts === "object"
      ? (channelObj.accounts as Record<string, unknown>)
      : undefined;
  const accountCfg = accountId && accountsObj ? accountsObj[accountId] : undefined;
  const accountMediaMax =
    accountCfg && typeof accountCfg === "object"
      ? (accountCfg as Record<string, unknown>).mediaMaxMb
      : undefined;
  // Priority: account-specific > channel-level > global default
  const limitMb =
    (typeof accountMediaMax === "number" ? accountMediaMax : undefined) ??
    channelMediaMax ??
    params.cfg.agents?.defaults?.mediaMaxMb;
  return typeof limitMb === "number" ? limitMb * 1024 * 1024 : undefined;
}

function inferAttachmentFilename(params: {
  mediaHint?: string;
  contentType?: string;
}): string | undefined {
  const mediaHint = params.mediaHint?.trim();
  if (mediaHint) {
    try {
      if (mediaHint.startsWith("file://")) {
        const filePath = fileURLToPath(mediaHint);
        const base = path.basename(filePath);
        if (base) {
          return base;
        }
      } else if (/^https?:\/\//i.test(mediaHint)) {
        const url = new URL(mediaHint);
        const base = path.basename(url.pathname);
        if (base) {
          return base;
        }
      } else {
        const base = path.basename(mediaHint);
        if (base) {
          return base;
        }
      }
    } catch {
      // fall through to content-type based default
    }
  }
  const ext = params.contentType ? extensionForMime(params.contentType) : undefined;
  return ext ? `attachment${ext}` : "attachment";
}

function normalizeBase64Payload(params: { base64?: string; contentType?: string }): {
  base64?: string;
  contentType?: string;
} {
  if (!params.base64) {
    return { base64: params.base64, contentType: params.contentType };
  }
  const match = /^data:([^;]+);base64,(.*)$/i.exec(params.base64.trim());
  if (!match) {
    return { base64: params.base64, contentType: params.contentType };
  }
  const [, mime, payload] = match;
  return {
    base64: payload,
    contentType: params.contentType ?? mime,
  };
}

export type AttachmentMediaPolicy =
  | {
      mode: "sandbox";
      sandboxRoot: string;
    }
  | {
      mode: "host";
      localRoots?: readonly string[];
    };

export function resolveAttachmentMediaPolicy(params: {
  sandboxRoot?: string;
  mediaLocalRoots?: readonly string[];
}): AttachmentMediaPolicy {
  const sandboxRoot = params.sandboxRoot?.trim();
  if (sandboxRoot) {
    return {
      mode: "sandbox",
      sandboxRoot,
    };
  }
  return {
    mode: "host",
    localRoots: params.mediaLocalRoots,
  };
}

function buildAttachmentMediaLoadOptions(params: {
  policy: AttachmentMediaPolicy;
  maxBytes?: number;
}):
  | {
      maxBytes?: number;
      sandboxValidated: true;
      readFile: (filePath: string) => Promise<Buffer>;
    }
  | {
      maxBytes?: number;
      localRoots?: readonly string[];
    } {
  if (params.policy.mode === "sandbox") {
    const readSandboxFile = createRootScopedReadFile({
      rootDir: params.policy.sandboxRoot.trim(),
    });
    return {
      maxBytes: params.maxBytes,
      sandboxValidated: true,
      readFile: readSandboxFile,
    };
  }
  return {
    maxBytes: params.maxBytes,
    localRoots: params.policy.localRoots,
  };
}

async function hydrateAttachmentPayload(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  dryRun?: boolean;
  contentTypeParam?: string | null;
  mediaHint?: string | null;
  fileHint?: string | null;
  mediaPolicy: AttachmentMediaPolicy;
}) {
  const contentTypeParam = params.contentTypeParam ?? undefined;
  const rawBuffer = readStringParam(params.args, "buffer", { trim: false });
  const normalized = normalizeBase64Payload({
    base64: rawBuffer,
    contentType: contentTypeParam ?? undefined,
  });
  if (normalized.base64 !== rawBuffer && normalized.base64) {
    params.args.buffer = normalized.base64;
    if (normalized.contentType && !contentTypeParam) {
      params.args.contentType = normalized.contentType;
    }
  }

  const filename = readStringParam(params.args, "filename");
  const mediaSource = (params.mediaHint ?? undefined) || (params.fileHint ?? undefined);

  if (!params.dryRun && !readStringParam(params.args, "buffer", { trim: false }) && mediaSource) {
    const maxBytes = resolveAttachmentMaxBytes({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
    });
    const media = await loadWebMedia(
      mediaSource,
      buildAttachmentMediaLoadOptions({ policy: params.mediaPolicy, maxBytes }),
    );
    params.args.buffer = media.buffer.toString("base64");
    if (!contentTypeParam && media.contentType) {
      params.args.contentType = media.contentType;
    }
    if (!filename) {
      params.args.filename = inferAttachmentFilename({
        mediaHint: media.fileName ?? mediaSource,
        contentType: media.contentType ?? contentTypeParam ?? undefined,
      });
    }
  } else if (!filename) {
    params.args.filename = inferAttachmentFilename({
      mediaHint: mediaSource,
      contentType: contentTypeParam ?? undefined,
    });
  }
}

export async function normalizeSandboxMediaParams(params: {
  args: Record<string, unknown>;
  mediaPolicy: AttachmentMediaPolicy;
}): Promise<void> {
  const sandboxRoot =
    params.mediaPolicy.mode === "sandbox" ? params.mediaPolicy.sandboxRoot.trim() : undefined;
  const mediaKeys: Array<"media" | "path" | "filePath"> = ["media", "path", "filePath"];
  for (const key of mediaKeys) {
    const raw = readStringParam(params.args, key, { trim: false });
    if (!raw) {
      continue;
    }
    assertMediaNotDataUrl(raw);
    if (!sandboxRoot) {
      continue;
    }
    const normalized = await resolveSandboxedMediaSource({ media: raw, sandboxRoot });
    if (normalized !== raw) {
      params.args[key] = normalized;
    }
  }
}

export async function normalizeSandboxMediaList(params: {
  values: string[];
  sandboxRoot?: string;
}): Promise<string[]> {
  const sandboxRoot = params.sandboxRoot?.trim();
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of params.values) {
    const raw = value?.trim();
    if (!raw) {
      continue;
    }
    assertMediaNotDataUrl(raw);
    const resolved = sandboxRoot
      ? await resolveSandboxedMediaSource({ media: raw, sandboxRoot })
      : raw;
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

async function hydrateAttachmentActionPayload(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  dryRun?: boolean;
  /** If caption is missing, copy message -> caption. */
  allowMessageCaptionFallback?: boolean;
  mediaPolicy: AttachmentMediaPolicy;
}): Promise<void> {
  const mediaHint = readStringParam(params.args, "media", { trim: false });
  const fileHint =
    readStringParam(params.args, "path", { trim: false }) ??
    readStringParam(params.args, "filePath", { trim: false });
  const contentTypeParam =
    readStringParam(params.args, "contentType") ?? readStringParam(params.args, "mimeType");

  if (params.allowMessageCaptionFallback) {
    const caption = readStringParam(params.args, "caption", { allowEmpty: true })?.trim();
    const message = readStringParam(params.args, "message", { allowEmpty: true })?.trim();
    if (!caption && message) {
      params.args.caption = message;
    }
  }

  await hydrateAttachmentPayload({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    args: params.args,
    dryRun: params.dryRun,
    contentTypeParam,
    mediaHint,
    fileHint,
    mediaPolicy: params.mediaPolicy,
  });
}

export async function hydrateAttachmentParamsForAction(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  action: ChannelMessageActionName;
  dryRun?: boolean;
  mediaPolicy: AttachmentMediaPolicy;
}): Promise<void> {
  if (params.action !== "sendAttachment" && params.action !== "setGroupIcon") {
    return;
  }
  await hydrateAttachmentActionPayload({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    args: params.args,
    dryRun: params.dryRun,
    mediaPolicy: params.mediaPolicy,
    allowMessageCaptionFallback: params.action === "sendAttachment",
  });
}

export function parseButtonsParam(params: Record<string, unknown>): void {
  const raw = params.buttons;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.buttons;
    return;
  }
  try {
    params.buttons = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--buttons must be valid JSON");
  }
}

export function parseCardParam(params: Record<string, unknown>): void {
  const raw = params.card;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.card;
    return;
  }
  try {
    params.card = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--card must be valid JSON");
  }
}

export function parseComponentsParam(params: Record<string, unknown>): void {
  const raw = params.components;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.components;
    return;
  }
  try {
    params.components = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--components must be valid JSON");
  }
}

/**
 * Strip components that are empty or auto-populated skeletons.
 *
 * Models (especially GPT-family) tend to fill the `components` schema with
 * empty scaffolding like `{ blocks: [], modal: { fields: [], title: "" } }`
 * even when the user only wants a plain send. These empty containers cause
 * Discord rendering issues (broken attachment display, red X buttons) and
 * modal validation errors (`components.modal.fields must be a non-empty array`).
 *
 * See: https://github.com/openclaw/openclaw/issues/43015
 */
export function stripEmptyComponents(params: Record<string, unknown>): void {
  const components = params.components;
  if (components == null || typeof components !== "object") {
    return;
  }

  // Preserve array-based components (Discord TopLevelComponents[]) — they
  // are a valid payload format and should never be stripped.
  if (Array.isArray(components)) {
    return;
  }

  const comp = components as Record<string, unknown>;

  // Strip empty modal (no fields or only empty fields array)
  if (comp.modal != null && typeof comp.modal === "object") {
    const modal = comp.modal as Record<string, unknown>;
    const fields = modal.fields;
    if (!Array.isArray(fields) || fields.length === 0) {
      delete comp.modal;
    }
  }

  // Check if the remaining components have any meaningful content.
  // Preserve container-only payloads (accentColor, reusable, spoiler)
  // as they carry valid Discord styling metadata.
  const hasBlocks = Array.isArray(comp.blocks) && comp.blocks.length > 0;
  const hasText = typeof comp.text === "string" && comp.text.trim().length > 0;
  const hasModal = comp.modal != null;
  const hasContainer = comp.container != null && typeof comp.container === "object";
  const hasReusable = comp.reusable === true;

  // If nothing meaningful remains, remove the entire components object
  if (!hasBlocks && !hasText && !hasModal && !hasContainer && !hasReusable) {
    delete params.components;
  }
}
