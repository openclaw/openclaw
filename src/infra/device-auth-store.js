import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { clearDeviceAuthTokenFromStore, loadDeviceAuthTokenFromStore, storeDeviceAuthTokenInStore, } from "../shared/device-auth-store.js";
const DEVICE_AUTH_FILE = "device-auth.json";
function resolveDeviceAuthPath(env = process.env) {
    return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}
function readStore(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") {
            return null;
        }
        if (!parsed.tokens || typeof parsed.tokens !== "object") {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function writeStore(filePath, store) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(filePath, 0o600);
    }
    catch {
        // best-effort
    }
}
export function loadDeviceAuthToken(params) {
    const filePath = resolveDeviceAuthPath(params.env);
    return loadDeviceAuthTokenFromStore({
        adapter: { readStore: () => readStore(filePath), writeStore: (_store) => { } },
        deviceId: params.deviceId,
        role: params.role,
    });
}
export function storeDeviceAuthToken(params) {
    const filePath = resolveDeviceAuthPath(params.env);
    return storeDeviceAuthTokenInStore({
        adapter: {
            readStore: () => readStore(filePath),
            writeStore: (store) => writeStore(filePath, store),
        },
        deviceId: params.deviceId,
        role: params.role,
        token: params.token,
        scopes: params.scopes,
    });
}
export function clearDeviceAuthToken(params) {
    const filePath = resolveDeviceAuthPath(params.env);
    clearDeviceAuthTokenFromStore({
        adapter: {
            readStore: () => readStore(filePath),
            writeStore: (store) => writeStore(filePath, store),
        },
        deviceId: params.deviceId,
        role: params.role,
    });
}
