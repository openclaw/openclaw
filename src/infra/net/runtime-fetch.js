import { loadUndiciRuntimeDeps } from "./undici-runtime.js";
function isFormDataLike(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.entries === "function" &&
        value[Symbol.toStringTag] === "FormData");
}
function normalizeRuntimeFormData(body, RuntimeFormData) {
    if (!isFormDataLike(body) || typeof RuntimeFormData !== "function") {
        return body;
    }
    if (body instanceof RuntimeFormData) {
        return body;
    }
    const next = new RuntimeFormData();
    for (const [key, value] of body.entries()) {
        const namedValue = value;
        // File.name is the standard filename property; skip empty/whitespace-only values
        const fileName = typeof namedValue.name === "string" && namedValue.name.trim() ? namedValue.name : undefined;
        if (fileName) {
            next.append(key, value, fileName);
        }
        else {
            next.append(key, value);
        }
    }
    // undici.FormData is structurally compatible with BodyInit but lives in a separate
    // type namespace; the cast avoids a cross-implementation assignability error.
    return next;
}
function normalizeRuntimeRequestInit(init, RuntimeFormData) {
    if (!init?.body) {
        return init;
    }
    const body = normalizeRuntimeFormData(init.body, RuntimeFormData);
    if (body === init.body) {
        return init;
    }
    const headers = new Headers(init.headers);
    headers.delete("content-length");
    headers.delete("content-type");
    return {
        ...init,
        headers,
        body,
    };
}
export function isMockedFetch(fetchImpl) {
    if (typeof fetchImpl !== "function") {
        return false;
    }
    return typeof fetchImpl.mock === "object";
}
export async function fetchWithRuntimeDispatcher(input, init) {
    const runtimeDeps = loadUndiciRuntimeDeps();
    const runtimeFetch = runtimeDeps.fetch;
    return (await runtimeFetch(input, normalizeRuntimeRequestInit(init, runtimeDeps.FormData)));
}
export async function fetchWithRuntimeDispatcherOrMockedGlobal(input, init) {
    if (isMockedFetch(globalThis.fetch)) {
        return await globalThis.fetch(input, init);
    }
    return await fetchWithRuntimeDispatcher(input, init);
}
