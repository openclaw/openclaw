import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { writeJsonAtomic } from "../infra/json-files.js";
const STORE_VERSION = 2;
function normalizeAccountId(accountId) {
    const trimmed = accountId?.trim();
    if (!trimmed) {
        return "default";
    }
    return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}
function resolveTelegramUpdateOffsetPath(accountId, env = process.env) {
    const stateDir = resolveStateDir(env, os.homedir);
    const normalized = normalizeAccountId(accountId);
    return path.join(stateDir, "telegram", `update-offset-${normalized}.json`);
}
function extractBotIdFromToken(token) {
    const trimmed = token?.trim();
    if (!trimmed) {
        return null;
    }
    const [rawBotId] = trimmed.split(":", 1);
    if (!rawBotId || !/^\d+$/.test(rawBotId)) {
        return null;
    }
    return rawBotId;
}
function safeParseState(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.version !== STORE_VERSION && parsed?.version !== 1) {
            return null;
        }
        if (parsed.lastUpdateId !== null && typeof parsed.lastUpdateId !== "number") {
            return null;
        }
        if (parsed.version === STORE_VERSION &&
            parsed.botId !== null &&
            typeof parsed.botId !== "string") {
            return null;
        }
        return {
            version: STORE_VERSION,
            lastUpdateId: parsed.lastUpdateId ?? null,
            botId: parsed.version === STORE_VERSION ? (parsed.botId ?? null) : null,
        };
    }
    catch {
        return null;
    }
}
export async function readTelegramUpdateOffset(params) {
    const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
    try {
        const raw = await fs.readFile(filePath, "utf-8");
        const parsed = safeParseState(raw);
        const expectedBotId = extractBotIdFromToken(params.botToken);
        if (expectedBotId && parsed?.botId && parsed.botId !== expectedBotId) {
            return null;
        }
        if (expectedBotId && parsed?.botId === null) {
            return null;
        }
        return parsed?.lastUpdateId ?? null;
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT") {
            return null;
        }
        return null;
    }
}
export async function writeTelegramUpdateOffset(params) {
    const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
    const payload = {
        version: STORE_VERSION,
        lastUpdateId: params.updateId,
        botId: extractBotIdFromToken(params.botToken),
    };
    await writeJsonAtomic(filePath, payload, {
        mode: 0o600,
        trailingNewline: true,
        ensureDirMode: 0o700,
    });
}
export async function deleteTelegramUpdateOffset(params) {
    const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
    try {
        await fs.unlink(filePath);
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT") {
            return;
        }
        throw err;
    }
}
