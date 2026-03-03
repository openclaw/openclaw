import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
export function parseConfigPath(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {
            ok: false,
            error: "Invalid path. Use dot notation (e.g. foo.bar).",
        };
    }
    const parts = trimmed.split(".").map((part) => part.trim());
    if (parts.some((part) => !part)) {
        return {
            ok: false,
            error: "Invalid path. Use dot notation (e.g. foo.bar).",
        };
    }
    if (parts.some((part) => isBlockedObjectKey(part))) {
        return { ok: false, error: "Invalid path segment." };
    }
    return { ok: true, path: parts };
}
export function setConfigValueAtPath(root, path, value) {
    let cursor = root;
    for (let idx = 0; idx < path.length - 1; idx += 1) {
        const key = path[idx];
        const next = cursor[key];
        if (!isPlainObject(next)) {
            cursor[key] = {};
        }
        cursor = cursor[key];
    }
    cursor[path[path.length - 1]] = value;
}
export function unsetConfigValueAtPath(root, path) {
    const stack = [];
    let cursor = root;
    for (let idx = 0; idx < path.length - 1; idx += 1) {
        const key = path[idx];
        const next = cursor[key];
        if (!isPlainObject(next)) {
            return false;
        }
        stack.push({ node: cursor, key });
        cursor = next;
    }
    const leafKey = path[path.length - 1];
    if (!(leafKey in cursor)) {
        return false;
    }
    delete cursor[leafKey];
    for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
        const { node, key } = stack[idx];
        const child = node[key];
        if (isPlainObject(child) && Object.keys(child).length === 0) {
            delete node[key];
        }
        else {
            break;
        }
    }
    return true;
}
export function getConfigValueAtPath(root, path) {
    let cursor = root;
    for (const key of path) {
        if (!isPlainObject(cursor)) {
            return undefined;
        }
        cursor = cursor[key];
    }
    return cursor;
}
