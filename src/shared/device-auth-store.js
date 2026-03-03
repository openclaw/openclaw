import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes, } from "./device-auth.js";
export function loadDeviceAuthTokenFromStore(params) {
    const store = params.adapter.readStore();
    if (!store || store.deviceId !== params.deviceId) {
        return null;
    }
    const role = normalizeDeviceAuthRole(params.role);
    const entry = store.tokens[role];
    if (!entry || typeof entry.token !== "string") {
        return null;
    }
    return entry;
}
export function storeDeviceAuthTokenInStore(params) {
    const role = normalizeDeviceAuthRole(params.role);
    const existing = params.adapter.readStore();
    const next = {
        version: 1,
        deviceId: params.deviceId,
        tokens: existing && existing.deviceId === params.deviceId && existing.tokens
            ? { ...existing.tokens }
            : {},
    };
    const entry = {
        token: params.token,
        role,
        scopes: normalizeDeviceAuthScopes(params.scopes),
        updatedAtMs: Date.now(),
    };
    next.tokens[role] = entry;
    params.adapter.writeStore(next);
    return entry;
}
export function clearDeviceAuthTokenFromStore(params) {
    const store = params.adapter.readStore();
    if (!store || store.deviceId !== params.deviceId) {
        return;
    }
    const role = normalizeDeviceAuthRole(params.role);
    if (!store.tokens[role]) {
        return;
    }
    const next = {
        version: 1,
        deviceId: store.deviceId,
        tokens: { ...store.tokens },
    };
    delete next.tokens[role];
    params.adapter.writeStore(next);
}
