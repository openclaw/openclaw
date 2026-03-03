import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { expandHomePrefix } from "../infra/home-dir.js";
import { CONFIG_DIR } from "../utils.js";
export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");
export function resolveCronStorePath(storePath) {
    if (storePath?.trim()) {
        const raw = storePath.trim();
        if (raw.startsWith("~")) {
            return path.resolve(expandHomePrefix(raw));
        }
        return path.resolve(raw);
    }
    return DEFAULT_CRON_STORE_PATH;
}
export async function loadCronStore(storePath) {
    try {
        const raw = await fs.promises.readFile(storePath, "utf-8");
        let parsed;
        try {
            parsed = JSON5.parse(raw);
        }
        catch (err) {
            throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
                cause: err,
            });
        }
        const parsedRecord = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
        const jobs = Array.isArray(parsedRecord.jobs) ? parsedRecord.jobs : [];
        return {
            version: 1,
            jobs: jobs.filter(Boolean),
        };
    }
    catch (err) {
        if (err?.code === "ENOENT") {
            return { version: 1, jobs: [] };
        }
        throw err;
    }
}
export async function saveCronStore(storePath, store) {
    await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
    const { randomBytes } = await import("node:crypto");
    const json = JSON.stringify(store, null, 2);
    let previous = null;
    try {
        previous = await fs.promises.readFile(storePath, "utf-8");
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }
    if (previous === json) {
        return;
    }
    const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await fs.promises.writeFile(tmp, json, "utf-8");
    if (previous !== null) {
        try {
            await fs.promises.copyFile(storePath, `${storePath}.bak`);
        }
        catch {
            // best-effort
        }
    }
    await renameWithRetry(tmp, storePath);
}
const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;
async function renameWithRetry(src, dest) {
    for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
        try {
            await fs.promises.rename(src, dest);
            return;
        }
        catch (err) {
            const code = err.code;
            if (code === "EBUSY" && attempt < RENAME_MAX_RETRIES) {
                await new Promise((resolve) => setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt));
                continue;
            }
            // Windows doesn't reliably support atomic replace via rename when dest exists.
            if (code === "EPERM" || code === "EEXIST") {
                await fs.promises.copyFile(src, dest);
                await fs.promises.unlink(src).catch(() => { });
                return;
            }
            throw err;
        }
    }
}
