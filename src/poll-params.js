import { readSnakeCaseParamRaw } from "./param-key.js";
import { normalizeLowercaseStringOrEmpty } from "./shared/string-coerce.js";
const SHARED_POLL_CREATION_PARAM_DEFS = {
    pollQuestion: { kind: "string" },
    pollOption: { kind: "stringArray" },
    pollDurationHours: { kind: "number" },
    pollMulti: { kind: "boolean" },
};
const TELEGRAM_POLL_CREATION_PARAM_DEFS = {
    pollDurationSeconds: { kind: "number" },
    pollAnonymous: { kind: "boolean" },
    pollPublic: { kind: "boolean" },
};
export const POLL_CREATION_PARAM_DEFS = {
    ...SHARED_POLL_CREATION_PARAM_DEFS,
    ...TELEGRAM_POLL_CREATION_PARAM_DEFS,
};
const POLL_CREATION_PARAM_NAMES = Object.keys(POLL_CREATION_PARAM_DEFS);
export const SHARED_POLL_CREATION_PARAM_NAMES = Object.keys(SHARED_POLL_CREATION_PARAM_DEFS);
function readPollParamRaw(params, key) {
    return readSnakeCaseParamRaw(params, key);
}
export function resolveTelegramPollVisibility(params) {
    if (params.pollAnonymous && params.pollPublic) {
        throw new Error("pollAnonymous and pollPublic are mutually exclusive");
    }
    return params.pollAnonymous ? true : params.pollPublic ? false : undefined;
}
export function hasPollCreationParams(params) {
    for (const key of POLL_CREATION_PARAM_NAMES) {
        const def = POLL_CREATION_PARAM_DEFS[key];
        const value = readPollParamRaw(params, key);
        if (def.kind === "string" && typeof value === "string" && value.trim().length > 0) {
            return true;
        }
        if (def.kind === "stringArray") {
            if (Array.isArray(value) &&
                value.some((entry) => typeof entry === "string" && entry.trim())) {
                return true;
            }
            if (typeof value === "string" && value.trim().length > 0) {
                return true;
            }
        }
        if (def.kind === "number") {
            // Treat zero-valued numeric defaults as unset, but preserve any non-zero
            // numeric value as explicit poll intent so invalid durations still hit
            // the poll-only validation path.
            if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
                return true;
            }
            if (typeof value === "string") {
                const trimmed = value.trim();
                const parsed = Number(trimmed);
                if (trimmed.length > 0 && Number.isFinite(parsed) && parsed !== 0) {
                    return true;
                }
            }
        }
        if (def.kind === "boolean") {
            if (value === true) {
                return true;
            }
            if (typeof value === "string" && normalizeLowercaseStringOrEmpty(value) === "true") {
                return true;
            }
        }
    }
    return false;
}
