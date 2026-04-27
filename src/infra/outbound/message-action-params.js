import { assertMediaNotDataUrl, resolveSandboxedMediaSource } from "../../agents/sandbox-paths.js";
import { readStringParam } from "../../agents/tools/common.js";
import { resolveChannelMessageToolMediaSourceParamKeys } from "../../channels/plugins/message-action-discovery.js";
import { createRootScopedReadFile } from "../../infra/fs-safe.js";
import { basenameFromMediaSource } from "../../infra/local-file-access.js";
import { resolveChannelAccountMediaMaxMb } from "../../media/configured-max-bytes.js";
import { buildOutboundMediaLoadOptions, resolveOutboundMediaAccess, resolveOutboundMediaLocalRoots, } from "../../media/load-options.js";
import { extensionForMime } from "../../media/mime.js";
import { loadWebMedia } from "../../media/web-media.js";
import { resolveSnakeCaseParamKey } from "../../param-key.js";
import { readBooleanParam as readBooleanParamShared } from "../../plugin-sdk/boolean-param.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { hasPotentialPluginActionParam } from "./message-action-param-keys.js";
export const readBooleanParam = readBooleanParamShared;
export const BASE_ACTION_MEDIA_SOURCE_PARAM_KEYS = [
    "media",
    "path",
    "filePath",
    "mediaUrl",
    "fileUrl",
    "image",
];
function readMediaParam(args, key) {
    return readStringParam(args, key, { trim: false });
}
function resolveMediaParamEntry(args, key) {
    const resolvedKey = resolveSnakeCaseParamKey(args, key);
    if (!resolvedKey) {
        return undefined;
    }
    const value = readMediaParam(args, key);
    if (!value) {
        return undefined;
    }
    return {
        key: resolvedKey,
        value,
    };
}
function buildActionMediaSourceParamKeys(extraParamKeys) {
    const keys = new Set(BASE_ACTION_MEDIA_SOURCE_PARAM_KEYS);
    extraParamKeys?.forEach((key) => keys.add(key));
    return Array.from(keys);
}
export function resolveExtraActionMediaSourceParamKeys(params) {
    if (!hasPotentialPluginActionParam(params.args)) {
        return [];
    }
    return resolveChannelMessageToolMediaSourceParamKeys({
        cfg: params.cfg,
        action: params.action,
        channel: params.channel,
        accountId: params.accountId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId: params.agentId,
        requesterSenderId: params.requesterSenderId,
        senderIsOwner: params.senderIsOwner,
    });
}
export function collectActionMediaSourceHints(args, extraParamKeys) {
    const sources = [];
    for (const key of buildActionMediaSourceParamKeys(extraParamKeys)) {
        const entry = resolveMediaParamEntry(args, key);
        if (entry && normalizeOptionalString(entry.value)) {
            sources.push(entry.value);
        }
    }
    return sources;
}
function readAttachmentMediaHint(args) {
    return readMediaParam(args, "media") ?? readMediaParam(args, "mediaUrl");
}
function readAttachmentFileHint(args) {
    return (readMediaParam(args, "path") ??
        readMediaParam(args, "filePath") ??
        readMediaParam(args, "fileUrl"));
}
function resolveAttachmentMaxBytes(params) {
    // Priority: account-specific > channel-level > global default
    const limitMb = resolveChannelAccountMediaMaxMb(params) ?? params.cfg.agents?.defaults?.mediaMaxMb;
    return typeof limitMb === "number" ? limitMb * 1024 * 1024 : undefined;
}
function inferAttachmentFilename(params) {
    const mediaHint = params.mediaHint?.trim();
    if (mediaHint) {
        const base = basenameFromMediaSource(mediaHint);
        if (base) {
            return base;
        }
    }
    const ext = params.contentType ? extensionForMime(params.contentType) : undefined;
    return ext ? `attachment${ext}` : "attachment";
}
function normalizeBase64Payload(params) {
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
export function resolveAttachmentMediaPolicy(params) {
    const sandboxRoot = params.sandboxRoot?.trim();
    if (sandboxRoot) {
        return {
            mode: "sandbox",
            sandboxRoot,
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
function buildAttachmentMediaLoadOptions(params) {
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
    return buildOutboundMediaLoadOptions({
        maxBytes: params.maxBytes,
        mediaAccess: params.policy.mediaAccess,
        mediaLocalRoots: params.policy.mediaLocalRoots,
        mediaReadFile: params.policy.mediaReadFile,
    });
}
async function hydrateAttachmentPayload(params) {
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
        const media = await loadWebMedia(mediaSource, buildAttachmentMediaLoadOptions({ policy: params.mediaPolicy, maxBytes }));
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
    }
    else if (!filename) {
        params.args.filename = inferAttachmentFilename({
            mediaHint: mediaSource,
            contentType: contentTypeParam ?? undefined,
        });
    }
}
export async function normalizeSandboxMediaParams(params) {
    const sandboxRoot = params.mediaPolicy.mode === "sandbox" ? params.mediaPolicy.sandboxRoot.trim() : undefined;
    for (const key of buildActionMediaSourceParamKeys(params.extraParamKeys)) {
        const entry = resolveMediaParamEntry(params.args, key);
        if (!entry) {
            continue;
        }
        assertMediaNotDataUrl(entry.value);
        if (!sandboxRoot) {
            continue;
        }
        const normalized = await resolveSandboxedMediaSource({ media: entry.value, sandboxRoot });
        if (normalized !== entry.value) {
            params.args[entry.key] = normalized;
        }
    }
}
export async function normalizeSandboxMediaList(params) {
    const sandboxRoot = params.sandboxRoot?.trim();
    const normalized = [];
    const seen = new Set();
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
async function hydrateAttachmentActionPayload(params) {
    const mediaHint = readAttachmentMediaHint(params.args);
    const fileHint = readAttachmentFileHint(params.args);
    const contentTypeParam = readStringParam(params.args, "contentType") ?? readStringParam(params.args, "mimeType");
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
export async function hydrateAttachmentParamsForAction(params) {
    const shouldHydrateUploadFile = params.action === "upload-file";
    if (params.action !== "sendAttachment" &&
        params.action !== "setGroupIcon" &&
        !shouldHydrateUploadFile) {
        return;
    }
    await hydrateAttachmentActionPayload({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
        args: params.args,
        dryRun: params.dryRun,
        mediaPolicy: params.mediaPolicy,
        allowMessageCaptionFallback: params.action === "sendAttachment" || shouldHydrateUploadFile,
    });
}
export function parseJsonMessageParam(params, key) {
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
        params[key] = JSON.parse(trimmed);
    }
    catch {
        throw new Error(`--${key} must be valid JSON`);
    }
}
export function parseInteractiveParam(params) {
    const raw = params.interactive;
    if (typeof raw !== "string") {
        return;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        delete params.interactive;
        return;
    }
    try {
        params.interactive = JSON.parse(trimmed);
    }
    catch {
        throw new Error("--interactive must be valid JSON");
    }
}
