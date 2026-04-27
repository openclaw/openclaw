import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { executeCrestodianOperation, formatCrestodianPersistentPlan, isPersistentCrestodianOperation, parseCrestodianOperation, } from "./operations.js";
import { resolveCrestodianRescuePolicy } from "./rescue-policy.js";
const CRESTODIAN_COMMAND = "/crestodian";
const APPROVAL_RE = /^(yes|y|apply|approve|approved|do it)$/i;
function createCaptureRuntime() {
    const lines = [];
    const push = (...args) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
    return {
        runtime: {
            log: push,
            error: push,
            exit: (code) => {
                throw new Error(`Crestodian operation exited with code ${code}`);
            },
        },
        read: () => lines.join("\n").trim(),
    };
}
export function extractCrestodianRescueMessage(commandBody) {
    const normalized = commandBody.trim();
    const lower = normalized.toLowerCase();
    if (lower !== CRESTODIAN_COMMAND && !lower.startsWith(`${CRESTODIAN_COMMAND} `)) {
        return null;
    }
    return normalized.slice(CRESTODIAN_COMMAND.length).trim();
}
function resolvePendingDir(env = process.env) {
    return path.join(resolveStateDir(env), "crestodian", "rescue-pending");
}
function resolvePendingPath(input) {
    const key = JSON.stringify({
        channel: input.command.channelId ?? input.command.channel,
        from: input.command.from,
        senderId: input.command.senderId,
    });
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
    return path.join(resolvePendingDir(input.env), `${digest}.json`);
}
async function readPending(pendingPath, now = new Date()) {
    try {
        const parsed = JSON.parse(await fs.readFile(pendingPath, "utf8"));
        if (Date.parse(parsed.expiresAt) <= now.getTime()) {
            await fs.rm(pendingPath, { force: true });
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
async function writePending(pendingPath, pending) {
    await fs.mkdir(path.dirname(pendingPath), { recursive: true });
    await fs.writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    await fs.chmod(pendingPath, 0o600).catch(() => {
        // Best-effort on platforms/filesystems without POSIX modes.
    });
}
function buildAuditDetails(input) {
    return {
        rescue: true,
        channel: input.command.channelId ?? input.command.channel,
        accountId: input.command.to,
        senderId: input.command.senderId,
        from: input.command.from,
    };
}
function formatPersistentPlan(operation) {
    return formatCrestodianPersistentPlan(operation).replace("Say yes to apply.", "Reply /crestodian yes to apply.");
}
function formatUnsupportedRemoteOperation(operation) {
    if (operation.kind === "open-tui") {
        return [
            "Crestodian rescue cannot open the local TUI from a message channel.",
            "Use local `openclaw` for agent handoff, or ask for status, doctor, config, gateway, agents, or models.",
        ].join(" ");
    }
    return null;
}
export async function runCrestodianRescueMessage(input) {
    const rescueMessage = extractCrestodianRescueMessage(input.commandBody);
    if (rescueMessage === null) {
        return null;
    }
    const policy = resolveCrestodianRescuePolicy({
        cfg: input.cfg,
        agentId: input.agentId,
        senderIsOwner: input.command.senderIsOwner,
        isDirectMessage: !input.isGroup,
    });
    if (!policy.allowed) {
        return policy.message;
    }
    const pendingPath = resolvePendingPath(input);
    if (APPROVAL_RE.test(rescueMessage)) {
        const pending = await readPending(pendingPath);
        if (!pending) {
            return "No pending Crestodian rescue change is waiting for approval.";
        }
        const unsupported = formatUnsupportedRemoteOperation(pending.operation);
        if (unsupported) {
            await fs.rm(pendingPath, { force: true });
            return unsupported;
        }
        const capture = createCaptureRuntime();
        await executeCrestodianOperation(pending.operation, capture.runtime, {
            approved: true,
            auditDetails: pending.auditDetails,
            deps: input.deps,
        });
        await fs.rm(pendingPath, { force: true });
        return capture.read() || "Crestodian rescue change applied.";
    }
    const operation = parseCrestodianOperation(rescueMessage);
    const unsupported = formatUnsupportedRemoteOperation(operation);
    if (unsupported) {
        return unsupported;
    }
    if (isPersistentCrestodianOperation(operation)) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + policy.pendingTtlMinutes * 60_000);
        await writePending(pendingPath, {
            id: randomUUID(),
            createdAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
            operation,
            auditDetails: buildAuditDetails(input),
        });
        return formatPersistentPlan(operation);
    }
    const capture = createCaptureRuntime();
    await executeCrestodianOperation(operation, capture.runtime, {
        approved: true,
        auditDetails: buildAuditDetails(input),
        deps: input.deps,
    });
    return capture.read() || "Crestodian listened, clicked a claw, and found nothing to change.";
}
