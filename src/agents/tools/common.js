import fs from "node:fs/promises";
import { detectMime } from "../../media/mime.js";
import { sanitizeToolResultImages } from "../tool-images.js";
export const OWNER_ONLY_TOOL_ERROR = "Tool restricted to owner senders.";
export class ToolInputError extends Error {
    status = 400;
    constructor(message) {
        super(message);
        this.name = "ToolInputError";
    }
}
export class ToolAuthorizationError extends ToolInputError {
    status = 403;
    constructor(message) {
        super(message);
        this.name = "ToolAuthorizationError";
    }
}
export function createActionGate(actions) {
    return (key, defaultValue = true) => {
        const value = actions?.[key];
        if (value === undefined) {
            return defaultValue;
        }
        return value !== false;
    };
}
function toSnakeCaseKey(key) {
    return key
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase();
}
function readParamRaw(params, key) {
    if (Object.hasOwn(params, key)) {
        return params[key];
    }
    const snakeKey = toSnakeCaseKey(key);
    if (snakeKey !== key && Object.hasOwn(params, snakeKey)) {
        return params[snakeKey];
    }
    return undefined;
}
export function readStringParam(params, key, options = {}) {
    const { required = false, trim = true, label = key, allowEmpty = false } = options;
    const raw = readParamRaw(params, key);
    if (typeof raw !== "string") {
        if (required) {
            throw new ToolInputError(`${label} required`);
        }
        return undefined;
    }
    const value = trim ? raw.trim() : raw;
    if (!value && !allowEmpty) {
        if (required) {
            throw new ToolInputError(`${label} required`);
        }
        return undefined;
    }
    return value;
}
export function readStringOrNumberParam(params, key, options = {}) {
    const { required = false, label = key } = options;
    const raw = readParamRaw(params, key);
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return String(raw);
    }
    if (typeof raw === "string") {
        const value = raw.trim();
        if (value) {
            return value;
        }
    }
    if (required) {
        throw new ToolInputError(`${label} required`);
    }
    return undefined;
}
export function readNumberParam(params, key, options = {}) {
    const { required = false, label = key, integer = false } = options;
    const raw = readParamRaw(params, key);
    let value;
    if (typeof raw === "number" && Number.isFinite(raw)) {
        value = raw;
    }
    else if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed) {
            const parsed = Number.parseFloat(trimmed);
            if (Number.isFinite(parsed)) {
                value = parsed;
            }
        }
    }
    if (value === undefined) {
        if (required) {
            throw new ToolInputError(`${label} required`);
        }
        return undefined;
    }
    return integer ? Math.trunc(value) : value;
}
export function readStringArrayParam(params, key, options = {}) {
    const { required = false, label = key } = options;
    const raw = readParamRaw(params, key);
    if (Array.isArray(raw)) {
        const values = raw
            .filter((entry) => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean);
        if (values.length === 0) {
            if (required) {
                throw new ToolInputError(`${label} required`);
            }
            return undefined;
        }
        return values;
    }
    if (typeof raw === "string") {
        const value = raw.trim();
        if (!value) {
            if (required) {
                throw new ToolInputError(`${label} required`);
            }
            return undefined;
        }
        return [value];
    }
    if (required) {
        throw new ToolInputError(`${label} required`);
    }
    return undefined;
}
export function readReactionParams(params, options) {
    const emojiKey = options.emojiKey ?? "emoji";
    const removeKey = options.removeKey ?? "remove";
    const remove = typeof params[removeKey] === "boolean" ? params[removeKey] : false;
    const emoji = readStringParam(params, emojiKey, {
        required: true,
        allowEmpty: true,
    });
    if (remove && !emoji) {
        throw new ToolInputError(options.removeErrorMessage);
    }
    return { emoji, remove, isEmpty: !emoji };
}
export function jsonResult(payload) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload, null, 2),
            },
        ],
        details: payload,
    };
}
export function wrapOwnerOnlyToolExecution(tool, senderIsOwner) {
    if (tool.ownerOnly !== true || senderIsOwner || !tool.execute) {
        return tool;
    }
    return {
        ...tool,
        execute: async () => {
            throw new Error(OWNER_ONLY_TOOL_ERROR);
        },
    };
}
export async function imageResult(params) {
    const content = [
        {
            type: "text",
            text: params.extraText ?? `MEDIA:${params.path}`,
        },
        {
            type: "image",
            data: params.base64,
            mimeType: params.mimeType,
        },
    ];
    const result = {
        content,
        details: { path: params.path, ...params.details },
    };
    return await sanitizeToolResultImages(result, params.label, params.imageSanitization);
}
export async function imageResultFromFile(params) {
    const buf = await fs.readFile(params.path);
    const mimeType = (await detectMime({ buffer: buf.slice(0, 256) })) ?? "image/png";
    return await imageResult({
        label: params.label,
        path: params.path,
        base64: buf.toString("base64"),
        mimeType,
        extraText: params.extraText,
        details: params.details,
        imageSanitization: params.imageSanitization,
    });
}
/**
 * Validate and parse an `availableTags` parameter from untrusted input.
 * Returns `undefined` when the value is missing or not an array.
 * Entries that lack a string `name` are silently dropped.
 */
export function parseAvailableTags(raw) {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const result = raw
        .filter((t) => typeof t === "object" && t !== null && typeof t.name === "string")
        .map((t) => ({
        ...(t.id !== undefined && typeof t.id === "string" ? { id: t.id } : {}),
        name: t.name,
        ...(typeof t.moderated === "boolean" ? { moderated: t.moderated } : {}),
        ...(t.emoji_id === null || typeof t.emoji_id === "string" ? { emoji_id: t.emoji_id } : {}),
        ...(t.emoji_name === null || typeof t.emoji_name === "string"
            ? { emoji_name: t.emoji_name }
            : {}),
    }));
    // Return undefined instead of empty array to avoid accidentally clearing all tags
    return result.length ? result : undefined;
}
