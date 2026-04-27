import fs from "node:fs";
import JSON5 from "json5";
export function safeReadDir(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
export function existsDir(dir) {
    try {
        return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    }
    catch {
        return false;
    }
}
export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
export function fileExists(p) {
    try {
        return fs.existsSync(p) && fs.statSync(p).isFile();
    }
    catch {
        return false;
    }
}
export function isLegacyWhatsAppAuthFile(name) {
    if (name === "creds.json" || name === "creds.json.bak") {
        return true;
    }
    if (!name.endsWith(".json")) {
        return false;
    }
    return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
}
export function readSessionStoreJson5(storePath) {
    try {
        const raw = fs.readFileSync(storePath, "utf-8");
        const parsed = JSON5.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { store: parsed, ok: true };
        }
    }
    catch {
        // ignore
    }
    return { store: {}, ok: false };
}
