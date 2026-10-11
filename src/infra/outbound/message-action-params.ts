import { basenameFromMediaSource } from "@openclaw/fs-safe/advanced";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { basenameFromAnyPath } from "@openclaw/media-core/file-name";
import { extensionForMime } from "@openclaw/media-core/mime";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { assertMediaNotDataUrl, resolveSandboxedMediaSource } from "../../agents/sandbox-paths.js";
import { readStringArrayParam, readToolStringParam } from "../../agents/tools/common.js";
import { resolveChannelMessageToolMediaSourceParamKeysAsync } from "../../channels/plugins/message-action-discovery.js";
import type { ChannelId, ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { root } from "../../infra/fs-safe.js";
import { createBoundedOutboundMediaReadFile } from "../../media/bounded-read-file.js";
import { resolveChannelAccountMediaMaxMb } from "../../media/configured-max-bytes.js";
import {
  buildOutboundMediaLoadOptions,
  resolveOutboundMediaAccess,
  resolveOutboundMediaLocalRoots,
  type OutboundMediaAccess,
  type OutboundMediaReadFile,
} from "../../media/load-options.js";
import { resolveOutboundAttachmentFromBuffer } from "../../media/outbound-attachment.js";
import { MEDIA_MAX_BYTES } from "../../media/store.js";
import { loadWebMedia } from "../../media/web-media.js";
import { resolveSnakeCaseParamKey } from "../../param-key.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { hasPotentialPluginActionParam } from "./message-action-param-keys.js";

const BASE_ACTION_MEDIA_SOURCE_PARAM_KEYS = [
  "media",
  "path",
  "filePath",
  "mediaUrl",
  "fileUrl",
  "image",
] as const;

const STRUCTURED_ATTACHMENT_MEDIA_SOURCE_PARAM_KEYS = [
  "media",
  "mediaUrl",
  "path",
  "filePath",
  "fileUrl",
  "url",
] as const;
const STRUCTURED_ATTACHMENT_FILE_SOURCE_PARAM_KEYS = new Set(["path", "filePath", "fileUrl"]);
const SEND_BUFFER_DRY_RUN_MEDIA_URL = "buffer://message-send/attachment";

type StructuredAttachmentSource = {
  attachment: Record<string, unknown>;
  key: string;
  value: string;
  kind: "media" | "file";
  contentType?: string;
  filename?: string;
};

type StructuredAttachmentMode = "selected" | "all";

function readAttachmentContentType(args: Record<string, unknown>): string | undefined {
  return readToolStringParam(args, "contentType") ?? readToolStringParam(args, "mimeType");
}

function resolveMediaParamEntry(
  args: Record<string, unknown>,
  key: string,
): { key: string; value: string } | undefined {
  const resolvedKey = resolveSnakeCaseParamKey(args, key);
  if (!resolvedKey) {
    return undefined;
  }
  const value = readToolStringParam(args, key, { trim: false });
  return value ? { key: resolvedKey, value } : undefined;
}

function hasExplicitAttachmentPayload(
  args: Record<string, unknown>,
  extraParamKeys?: readonly string[],
): boolean {
  return (
    Boolean(readToolStringParam(args, "buffer", { trim: false })) ||
    buildActionMediaSourceParamKeys(extraParamKeys).some((key) => {
      const entry = resolveMediaParamEntry(args, key);
      return Boolean(entry && normalizeOptionalString(entry.value));
    })
  );
}

function hasExplicitSendMediaSource(
  args: Record<string, unknown>,
  extraParamKeys?: readonly string[],
): boolean {
  return (
    buildActionMediaSourceParamKeys(extraParamKeys).some((key) => {
      const entry = resolveMediaParamEntry(args, key);
      const value = entry ? normalizeOptionalString(entry.value) : undefined;
      return Boolean(value && value !== SEND_BUFFER_DRY_RUN_MEDIA_URL);
    }) ||
    readStringArrayParam(args, "mediaUrls")?.some(
      (value) => value !== SEND_BUFFER_DRY_RUN_MEDIA_URL,
    ) === true ||
    collectAttachmentSources(args).length > 0
  );
}

export function collectAttachmentSources(
  args: Record<string, unknown>,
): StructuredAttachmentSource[] {
  const attachments = args.attachments;
  if (!Array.isArray(attachments)) {
    return [];
  }
  const sources: StructuredAttachmentSource[] = [];
  for (const item of attachments) {
    if (!isRecord(item)) {
      continue;
    }
    for (const key of STRUCTURED_ATTACHMENT_MEDIA_SOURCE_PARAM_KEYS) {
      const entry = resolveMediaParamEntry(item, key);
      if (!entry || !normalizeOptionalString(entry.value)) {
        continue;
      }
      sources.push({
        attachment: item,
        key: entry.key,
        value: entry.value,
        kind: STRUCTURED_ATTACHMENT_FILE_SOURCE_PARAM_KEYS.has(key) ? "file" : "media",
        contentType: readAttachmentContentType(item),
        filename: readToolStringParam(item, "filename") ?? readToolStringParam(item, "name"),
      });
    }
  }
  return sources;
}

function selectStructuredAttachmentSources(
  args: Record<string, unknown>,
  extraParamKeys?: readonly string[],
  mode?: StructuredAttachmentMode,
): StructuredAttachmentSource[] {
  if (mode !== "all" && hasExplicitAttachmentPayload(args, extraParamKeys)) {
    return [];
  }
  const sources = collectAttachmentSources(args);
  return mode === "all" ? sources : sources.slice(0, 1);
}

function buildActionMediaSourceParamKeys(extraParamKeys?: readonly string[]): string[] {
  return [...new Set([...BASE_ACTION_MEDIA_SOURCE_PARAM_KEYS, ...(extraParamKeys ?? [])])];
}

type ExtraActionMediaSourceParams = {
  cfg: OpenClawConfig;
  action?: ChannelMessageActionName;
  args: Record<string, unknown>;
  channel?: string;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
};

export async function resolveExtraActionMediaSourceParamKeysAsync(
  params: ExtraActionMediaSourceParams,
): Promise<string[]> {
  if (!hasPotentialPluginActionParam(params.args)) {
    // Standard send params never need bundled action metadata discovery.
    return [];
  }
  return resolveChannelMessageToolMediaSourceParamKeysAsync(params);
}

export function collectActionMediaSourceHints(
  args: Record<string, unknown>,
  extraParamKeys?: readonly string[],
  options?: { structuredAttachments?: StructuredAttachmentMode },
): string[] {
  const sources: string[] = [];
  for (const key of buildActionMediaSourceParamKeys(extraParamKeys)) {
    const entry = resolveMediaParamEntry(args, key);
    if (entry && normalizeOptionalString(entry.value)) {
      sources.push(entry.value);
    }
  }
  return sources.concat(
    readStringArrayParam(args, "mediaUrls") ?? [],
    selectStructuredAttachmentSources(args, extraParamKeys, options?.structuredAttachments).map(
      (source) => source.value,
    ),
  );
}

function resolveAttachmentMaxBytes(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
}): number | undefined {
  // Priority: account-specific > channel-level > global default.
  const limitMb = asPositiveFiniteNumber(
    resolveChannelAccountMediaMaxMb(params) ?? params.cfg.agents?.defaults?.mediaMaxMb,
  );
  return limitMb === undefined ? undefined : limitMb * 1024 * 1024;
}

function inferAttachmentFilename(params: { mediaHint?: string; contentType?: string }): string {
  const mediaHint = params.mediaHint?.trim();
  if (mediaHint) {
    const base = basenameFromMediaSource(mediaHint);
    const safeBase = base ? basenameFromAnyPath(base) : undefined;
    if (safeBase) {
      return safeBase;
    }
  }
  const ext = params.contentType ? extensionForMime(params.contentType) : undefined;
  return ext ? `attachment${ext}` : "attachment";
}

function normalizeBase64Payload(params: { base64?: string; contentType?: string }): {
  base64?: string;
  contentType?: string;
} {
  const match = params.base64
    ? /^data:([^;,\s]+)(;(?!base64)[^,;\s]+)*;base64,(.*)$/is.exec(params.base64.trim())
    : null;
  if (!match) {
    return params;
  }
  const [, mime, , payload] = match;
  return {
    base64: payload,
    contentType: params.contentType ?? mime,
  };
}

type AttachmentMediaPolicy =
  | {
      mode: "sandbox";
      sandboxRoot: string;
      containerWorkdir?: string;
      mediaReadFile?: OutboundMediaReadFile;
    }
  | {
      mode: "host";
      mediaAccess?: OutboundMediaAccess;
      mediaLocalRoots?: readonly string[] | "any";
      mediaReadFile?: OutboundMediaReadFile;
    };

export function resolveAttachmentMediaPolicy(params: {
  sandboxRoot?: string;
  sandboxContainerWorkdir?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[] | "any";
  mediaReadFile?: OutboundMediaReadFile;
}): AttachmentMediaPolicy {
  const sandboxRoot = params.sandboxRoot?.trim();
  if (sandboxRoot) {
    return {
      mode: "sandbox",
      sandboxRoot,
      ...(params.sandboxContainerWorkdir
        ? { containerWorkdir: params.sandboxContainerWorkdir }
        : {}),
      ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
    };
  }
  const explicitLocalRoots = resolveOutboundMediaLocalRoots(params.mediaLocalRoots);
  return {
    mode: "host",
    mediaAccess: resolveOutboundMediaAccess({
      mediaAccess: params.mediaAccess,
      mediaLocalRoots: explicitLocalRoots === "any" ? undefined : explicitLocalRoots,
      mediaReadFile: params.mediaAccess?.readFile ? undefined : params.mediaReadFile,
    }),
    ...(explicitLocalRoots !== undefined ? { mediaLocalRoots: explicitLocalRoots } : {}),
    ...(params.mediaAccess?.readFile
      ? {}
      : params.mediaReadFile
        ? { mediaReadFile: params.mediaReadFile }
        : {}),
  };
}

function buildAttachmentMediaLoadOptions(params: {
  policy: AttachmentMediaPolicy;
  maxBytes?: number;
  optimizeImages?: boolean;
}) {
  if (params.policy.mode === "sandbox") {
    const sandboxRoot = params.policy.sandboxRoot.trim();
    let sandboxFsPromise: ReturnType<typeof root> | undefined;
    const readSandboxFile =
      params.policy.mediaReadFile ??
      createBoundedOutboundMediaReadFile(async (filePath, options) => {
        sandboxFsPromise ??= root(sandboxRoot);
        const sandboxFs = await sandboxFsPromise;
        return await sandboxFs.readBytes(filePath, { maxBytes: options?.maxBytes });
      });
    return {
      maxBytes: params.maxBytes,
      ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
      sandboxValidated: true,
      readFile: readSandboxFile,
    };
  }
  return buildOutboundMediaLoadOptions({
    maxBytes: params.maxBytes,
    mediaAccess: params.policy.mediaAccess,
    mediaLocalRoots: params.policy.mediaLocalRoots,
    mediaReadFile: params.policy.mediaReadFile,
    optimizeImages: params.optimizeImages,
  });
}

export async function normalizeSandboxMediaParams(params: {
  args: Record<string, unknown>;
  mediaPolicy: AttachmentMediaPolicy;
  extraParamKeys?: readonly string[];
  structuredAttachments?: StructuredAttachmentMode;
}): Promise<void> {
  const sandbox =
    params.mediaPolicy.mode === "sandbox"
      ? {
          sandboxRoot: params.mediaPolicy.sandboxRoot.trim(),
          containerWorkdir: params.mediaPolicy.containerWorkdir,
        }
      : undefined;
  const normalize = async (
    target: Record<string, unknown>,
    entry: { key: string; value: string },
  ) => {
    assertMediaNotDataUrl(entry.value);
    if (sandbox?.sandboxRoot) {
      const normalized = await resolveSandboxedMediaSource({ media: entry.value, ...sandbox });
      if (normalized !== entry.value) {
        target[entry.key] = normalized;
      }
    }
  };
  for (const key of buildActionMediaSourceParamKeys(params.extraParamKeys)) {
    const entry = resolveMediaParamEntry(params.args, key);
    if (entry) {
      await normalize(params.args, entry);
    }
  }
  for (const attachmentSource of selectStructuredAttachmentSources(
    params.args,
    params.extraParamKeys,
    params.structuredAttachments,
  )) {
    await normalize(attachmentSource.attachment, attachmentSource);
  }
}

export async function normalizeSandboxMediaSource(params: {
  value: string;
  sandboxRoot?: string;
  sandboxContainerWorkdir?: string;
}): Promise<string> {
  const sandboxRoot = params.sandboxRoot?.trim();
  const raw = params.value.trim();
  assertMediaNotDataUrl(raw);
  return sandboxRoot
    ? await resolveSandboxedMediaSource({
        media: raw,
        sandboxRoot,
        containerWorkdir: params.sandboxContainerWorkdir,
      })
    : raw;
}

export async function hydrateAttachmentParamsForAction(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  action: ChannelMessageActionName;
  dryRun?: boolean;
  preserveSendBuffer?: boolean;
  /** Pure ingress policy only: media publication must not run SQL-backed runtime guards. */
  assertClientUploadAllowed?: () => void;
  mediaPolicy: AttachmentMediaPolicy;
  extraParamKeys?: readonly string[];
}): Promise<void> {
  const shouldHydrateUploadFile = params.action === "upload-file";
  if (params.action === "send") {
    const { args, preserveSendBuffer } = params;
    if (hasExplicitSendMediaSource(args, params.extraParamKeys)) {
      delete args.buffer;
      return;
    }
    const rawBuffer = readToolStringParam(args, "buffer", { trim: false });
    if (!rawBuffer) {
      return;
    }
    const normalized = normalizeBase64Payload({
      base64: rawBuffer,
      contentType: readAttachmentContentType(args),
    });
    if (!normalized.base64) {
      return;
    }
    const filename =
      readToolStringParam(args, "filename") ??
      inferAttachmentFilename({
        contentType: normalized.contentType,
      });
    const maxBytes = resolveAttachmentMaxBytes(params) ?? MEDIA_MAX_BYTES;
    const estimatedBytes = estimateBase64DecodedBytes(normalized.base64);
    if (estimatedBytes > maxBytes) {
      throw new Error(`Media too large: ${estimatedBytes} bytes (limit: ${maxBytes} bytes)`);
    }
    const canonicalBase64 = canonicalizeBase64(normalized.base64);
    if (!canonicalBase64) {
      throw new Error("message.send buffer has invalid base64 data");
    }
    const staged =
      params.dryRun || preserveSendBuffer
        ? { path: SEND_BUFFER_DRY_RUN_MEDIA_URL, contentType: normalized.contentType }
        : await resolveOutboundAttachmentFromBuffer(
            Buffer.from(canonicalBase64, "base64"),
            maxBytes,
            {
              contentType: normalized.contentType,
              filename,
              assertCommitAllowed: params.assertClientUploadAllowed,
            },
          );
    args.media = staged.path;
    args.mediaUrl = staged.path;
    args.mediaUrls = [staged.path];
    if (!preserveSendBuffer) {
      delete args.buffer;
    }
    if (staged.contentType && !readToolStringParam(args, "contentType")) {
      args.contentType = staged.contentType;
    }
    if (!readToolStringParam(args, "filename")) {
      args.filename = filename;
    }
    return;
  }
  // Reply gets the same hydration as sendAttachment so threaded sends with
  // an attachment go through the resolver's localRoots/sandbox/size checks
  // instead of forwarding raw paths to the channel runtime. Reply has its
  // own `text`/`message` field, so don't fall back caption -> message.
  if (
    params.action !== "sendAttachment" &&
    params.action !== "setGroupIcon" &&
    params.action !== "reply" &&
    !shouldHydrateUploadFile
  ) {
    return;
  }
  const forceDocument =
    readBooleanParam(params.args, "forceDocument") ??
    readBooleanParam(params.args, "asDocument") ??
    false;
  const optimizeImages = shouldHydrateUploadFile && forceDocument ? false : undefined;
  const allowMessageCaptionFallback = params.action === "sendAttachment" || shouldHydrateUploadFile;
  const attachmentSource = selectStructuredAttachmentSources(params.args, params.extraParamKeys)[0];
  const mediaHint =
    readToolStringParam(params.args, "media", { trim: false }) ??
    readToolStringParam(params.args, "mediaUrl", { trim: false });
  const fileHint =
    readToolStringParam(params.args, "path", { trim: false }) ??
    readToolStringParam(params.args, "filePath", { trim: false }) ??
    readToolStringParam(params.args, "fileUrl", { trim: false });
  const contentTypeParam = readAttachmentContentType(params.args) ?? attachmentSource?.contentType;
  if (attachmentSource?.filename && !readToolStringParam(params.args, "filename")) {
    params.args.filename = attachmentSource.filename;
  }

  if (allowMessageCaptionFallback) {
    const caption = readToolStringParam(params.args, "caption", { allowEmpty: true });
    const message = readToolStringParam(params.args, "message", { allowEmpty: true });
    if (!caption && message) {
      params.args.caption = message;
    }
  }

  const selectedMediaHint =
    mediaHint ?? (attachmentSource?.kind === "media" ? attachmentSource.value : undefined);
  const selectedFileHint =
    fileHint ?? (attachmentSource?.kind === "file" ? attachmentSource.value : undefined);
  const rawBuffer = readToolStringParam(params.args, "buffer", { trim: false });
  const normalized = normalizeBase64Payload({
    base64: rawBuffer,
    contentType: contentTypeParam ?? undefined,
  });
  if (normalized.base64 !== rawBuffer && normalized.base64) {
    params.args.buffer = normalized.base64;
  }
  if (normalized.contentType && !readToolStringParam(params.args, "contentType")) {
    params.args.contentType = normalized.contentType;
  }

  const filename = readToolStringParam(params.args, "filename");
  const mediaSource = selectedMediaHint || selectedFileHint;

  if (!params.dryRun && !rawBuffer && mediaSource) {
    const maxBytes = resolveAttachmentMaxBytes(params);
    const media = await loadWebMedia(
      mediaSource,
      buildAttachmentMediaLoadOptions({
        policy: params.mediaPolicy,
        maxBytes,
        optimizeImages,
      }),
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
      contentType: normalized.contentType,
    });
  }
}

export function parseJsonMessageParam(params: Record<string, unknown>, key: string): void {
  const raw = params[key];
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params[key];
    return;
  }
  try {
    params[key] = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`--${key} must be valid JSON`);
  }
}
