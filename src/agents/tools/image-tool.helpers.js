import { estimateBase64DecodedBytes } from "../../media/base64.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { findNormalizedProviderValue } from "../model-selection.js";
import { extractAssistantText } from "../pi-embedded-utils.js";
import { coerceToolModelConfig } from "./model-config.helpers.js";
const IMAGE_REASONING_FALLBACK_SIGNATURES = new Set([
    "reasoning_content",
    "reasoning",
    "reasoning_details",
    "reasoning_text",
]);
const MAX_IMAGE_REASONING_FALLBACK_BLOCKS = 50;
const MAX_IMAGE_REASONING_SIGNATURE_PARSE_CHARS = 2_048;
const MAX_IMAGE_REASONING_SIGNATURE_SCAN_CHARS = 65_536;
function hasResponsesReasoningSignatureMarkers(value) {
    const scanned = value.slice(0, MAX_IMAGE_REASONING_SIGNATURE_SCAN_CHARS);
    return /"id"\s*:\s*"rs_/.test(scanned) && /"type"\s*:\s*"reasoning(?:[."])/.test(scanned);
}
function isImageReasoningFallbackSignature(value) {
    if (!value) {
        return false;
    }
    if (typeof value === "string") {
        if (IMAGE_REASONING_FALLBACK_SIGNATURES.has(value)) {
            return true;
        }
        const trimmed = value.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
            return false;
        }
        if (trimmed.length > MAX_IMAGE_REASONING_SIGNATURE_PARSE_CHARS) {
            return hasResponsesReasoningSignatureMarkers(trimmed);
        }
        try {
            return isImageReasoningFallbackSignature(JSON.parse(trimmed));
        }
        catch {
            return false;
        }
    }
    if (typeof value !== "object") {
        return false;
    }
    const record = value;
    const id = typeof record.id === "string" ? record.id : "";
    const type = typeof record.type === "string" ? record.type : "";
    return id.startsWith("rs_") && (type === "reasoning" || type.startsWith("reasoning."));
}
export function hasImageReasoningOnlyResponse(message) {
    if (extractAssistantText(message).trim() || !Array.isArray(message.content)) {
        return false;
    }
    let checkedBlocks = 0;
    for (const block of message.content) {
        checkedBlocks += 1;
        if (checkedBlocks > MAX_IMAGE_REASONING_FALLBACK_BLOCKS) {
            break;
        }
        if (!block || typeof block !== "object") {
            continue;
        }
        const record = block;
        if (record.type === "thinking" &&
            typeof record.thinking === "string" &&
            isImageReasoningFallbackSignature(record.thinkingSignature)) {
            return true;
        }
    }
    return false;
}
export function decodeDataUrl(dataUrl, opts) {
    const trimmed = dataUrl.trim();
    const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(trimmed);
    if (!match) {
        throw new Error("Invalid data URL (expected base64 data: URL).");
    }
    const mimeType = normalizeLowercaseStringOrEmpty(match[1]);
    if (!mimeType.startsWith("image/")) {
        throw new Error(`Unsupported data URL type: ${mimeType || "unknown"}`);
    }
    const b64 = (match[2] ?? "").trim();
    if (typeof opts?.maxBytes === "number" && estimateBase64DecodedBytes(b64) > opts.maxBytes) {
        throw new Error("Invalid data URL: payload exceeds size limit.");
    }
    const buffer = Buffer.from(b64, "base64");
    if (buffer.length === 0) {
        throw new Error("Invalid data URL: empty payload.");
    }
    return { buffer, mimeType, kind: "image" };
}
export function coerceImageAssistantText(params) {
    const stop = params.message.stopReason;
    const errorMessage = params.message.errorMessage?.trim();
    if (stop === "error" || stop === "aborted") {
        throw new Error(errorMessage
            ? `Image model failed (${params.provider}/${params.model}): ${errorMessage}`
            : `Image model failed (${params.provider}/${params.model})`);
    }
    if (errorMessage) {
        throw new Error(`Image model failed (${params.provider}/${params.model}): ${errorMessage}`);
    }
    const text = extractAssistantText(params.message);
    if (text.trim()) {
        return text.trim();
    }
    throw new Error(`Image model returned no text (${params.provider}/${params.model}).`);
}
export function coerceImageModelConfig(cfg) {
    return coerceToolModelConfig(cfg?.agents?.defaults?.imageModel);
}
export function resolveProviderVisionModelFromConfig(params) {
    const providerCfg = findNormalizedProviderValue(params.cfg?.models?.providers, params.provider);
    const models = providerCfg?.models ?? [];
    const picked = models.find((m) => Boolean((m?.id ?? "").trim()) && m.input?.includes("image"));
    const id = (picked?.id ?? "").trim();
    if (!id) {
        return null;
    }
    const slash = id.indexOf("/");
    const idProvider = slash === -1 ? "" : normalizeLowercaseStringOrEmpty(id.slice(0, slash));
    const selectedProvider = normalizeLowercaseStringOrEmpty(params.provider);
    return idProvider && idProvider === selectedProvider ? id : `${params.provider}/${id}`;
}
