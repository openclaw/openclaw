import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../shared/string-coerce.js";
const TOOL_CALL_TYPES = new Set(["tool_use", "toolcall", "tool_call"]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "tool_result_error"]);
const normalizeType = (value) => {
    return typeof value === "string" ? (normalizeOptionalLowercaseString(value) ?? "") : "";
};
export const extractToolCallNames = (message) => {
    const names = new Set();
    const toolNameRaw = message.toolName ?? message.tool_name;
    const toolName = typeof toolNameRaw === "string" ? normalizeOptionalString(toolNameRaw) : undefined;
    if (toolName) {
        names.add(toolName);
    }
    const content = message.content;
    if (!Array.isArray(content)) {
        return Array.from(names);
    }
    for (const entry of content) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const block = entry;
        const type = normalizeType(block.type);
        if (!TOOL_CALL_TYPES.has(type)) {
            continue;
        }
        const name = typeof block.name === "string" ? normalizeOptionalString(block.name) : undefined;
        if (name) {
            names.add(name);
        }
    }
    return Array.from(names);
};
export const hasToolCall = (message) => extractToolCallNames(message).length > 0;
export const countToolResults = (message) => {
    const content = message.content;
    if (!Array.isArray(content)) {
        return { total: 0, errors: 0 };
    }
    let total = 0;
    let errors = 0;
    for (const entry of content) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const block = entry;
        const type = normalizeType(block.type);
        if (!TOOL_RESULT_TYPES.has(type)) {
            continue;
        }
        total += 1;
        if (block.is_error === true) {
            errors += 1;
        }
    }
    return { total, errors };
};
