import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { writeJsonAtomic } from "./json-files.js";
export const DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE = "The gateway restart completed successfully. Tell the user OpenClaw restarted successfully and continue any pending work.";
const SENTINEL_FILENAME = "restart-sentinel.json";
export function formatDoctorNonInteractiveHint(env = process.env) {
    return `Run: ${formatCliCommand("openclaw doctor --non-interactive", env)}`;
}
export function resolveRestartSentinelPath(env = process.env) {
    return path.join(resolveStateDir(env), SENTINEL_FILENAME);
}
export async function writeRestartSentinel(payload, env = process.env) {
    const filePath = resolveRestartSentinelPath(env);
    const data = { version: 1, payload };
    await writeJsonAtomic(filePath, data, { trailingNewline: true, ensureDirMode: 0o700 });
    return filePath;
}
export async function removeRestartSentinelFile(filePath) {
    if (!filePath) {
        return;
    }
    await fs.unlink(filePath).catch(() => { });
}
export function buildRestartSuccessContinuation(params) {
    const message = params.continuationMessage?.trim();
    if (message) {
        return { kind: "agentTurn", message };
    }
    return params.sessionKey?.trim()
        ? { kind: "agentTurn", message: DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE }
        : null;
}
export async function readRestartSentinel(env = process.env) {
    const filePath = resolveRestartSentinelPath(env);
    try {
        const raw = await fs.readFile(filePath, "utf-8");
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            await fs.unlink(filePath).catch(() => { });
            return null;
        }
        if (!parsed || parsed.version !== 1 || !parsed.payload) {
            await fs.unlink(filePath).catch(() => { });
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
export async function hasRestartSentinel(env = process.env) {
    try {
        await fs.access(resolveRestartSentinelPath(env));
        return true;
    }
    catch {
        return false;
    }
}
export async function consumeRestartSentinel(env = process.env) {
    const filePath = resolveRestartSentinelPath(env);
    const parsed = await readRestartSentinel(env);
    if (!parsed) {
        return null;
    }
    await removeRestartSentinelFile(filePath);
    return parsed;
}
export function formatRestartSentinelMessage(payload) {
    const message = payload.message?.trim();
    if (message && (!payload.stats || payload.kind === "config-auto-recovery")) {
        return message;
    }
    const lines = [summarizeRestartSentinel(payload)];
    if (message) {
        lines.push(message);
    }
    const reason = payload.stats?.reason?.trim();
    if (reason && reason !== message) {
        lines.push(`Reason: ${reason}`);
    }
    if (payload.doctorHint?.trim()) {
        lines.push(payload.doctorHint.trim());
    }
    return lines.join("\n");
}
export function summarizeRestartSentinel(payload) {
    if (payload.kind === "config-auto-recovery") {
        return "Gateway auto-recovery";
    }
    const kind = payload.kind;
    const status = payload.status;
    const mode = payload.stats?.mode ? ` (${payload.stats.mode})` : "";
    return `Gateway restart ${kind} ${status}${mode}`.trim();
}
export function trimLogTail(input, maxChars = 8000) {
    if (!input) {
        return null;
    }
    const text = input.trimEnd();
    if (text.length <= maxChars) {
        return text;
    }
    return `…${text.slice(text.length - maxChars)}`;
}
