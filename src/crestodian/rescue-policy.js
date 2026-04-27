import { normalizeAgentId } from "../routing/session-key.js";
function resolvePendingTtlMinutes(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 15;
}
function resolveAgentEntry(cfg, agentId) {
    if (!agentId) {
        return undefined;
    }
    const id = normalizeAgentId(agentId);
    return cfg.agents?.list?.find((entry) => entry !== null && typeof entry === "object" && normalizeAgentId(entry.id) === id);
}
function resolveScopedExecConfig(cfg, agentId) {
    return resolveAgentEntry(cfg, agentId)?.tools?.exec;
}
function resolveScopedSandboxMode(cfg, agentId) {
    return (resolveAgentEntry(cfg, agentId)?.sandbox?.mode ?? cfg.agents?.defaults?.sandbox?.mode ?? "off");
}
function isYoloHostPosture(cfg, agentId) {
    const scopedExec = resolveScopedExecConfig(cfg, agentId);
    const globalExec = cfg.tools?.exec;
    const security = scopedExec?.security ?? globalExec?.security ?? "full";
    const ask = scopedExec?.ask ?? globalExec?.ask ?? "off";
    return security === "full" && ask === "off";
}
export function resolveCrestodianRescuePolicy(input) {
    const rescue = input.cfg.crestodian?.rescue;
    const configuredEnabled = rescue?.enabled ?? "auto";
    const ownerDmOnly = rescue?.ownerDmOnly ?? true;
    const pendingTtlMinutes = resolvePendingTtlMinutes(rescue?.pendingTtlMinutes);
    const sandboxActive = resolveScopedSandboxMode(input.cfg, input.agentId) !== "off";
    const yolo = !sandboxActive && isYoloHostPosture(input.cfg, input.agentId);
    const enabled = configuredEnabled === "auto" ? yolo : configuredEnabled;
    if (!enabled) {
        return {
            allowed: false,
            enabled,
            ownerDmOnly,
            pendingTtlMinutes,
            yolo,
            sandboxActive,
            reason: "disabled",
            message: "Crestodian rescue is disabled. Set crestodian.rescue.enabled=true or use YOLO host posture with sandboxing off.",
        };
    }
    if (sandboxActive) {
        return {
            allowed: false,
            enabled,
            ownerDmOnly,
            pendingTtlMinutes,
            yolo,
            sandboxActive,
            reason: "sandbox-active",
            message: "Crestodian rescue is blocked because OpenClaw sandboxing is active. Fix the install locally or disable sandboxing before using remote rescue.",
        };
    }
    if (configuredEnabled === "auto" && !yolo) {
        return {
            allowed: false,
            enabled,
            ownerDmOnly,
            pendingTtlMinutes,
            yolo,
            sandboxActive,
            reason: "not-yolo",
            message: "Crestodian rescue auto-mode only opens in YOLO host posture: tools.exec.security=full, tools.exec.ask=off, and sandboxing off.",
        };
    }
    if (!input.senderIsOwner) {
        return {
            allowed: false,
            enabled,
            ownerDmOnly,
            pendingTtlMinutes,
            yolo,
            sandboxActive,
            reason: "not-owner",
            message: "Crestodian rescue only accepts commands from an OpenClaw owner.",
        };
    }
    if (ownerDmOnly && !input.isDirectMessage) {
        return {
            allowed: false,
            enabled,
            ownerDmOnly,
            pendingTtlMinutes,
            yolo,
            sandboxActive,
            reason: "not-direct-message",
            message: "Crestodian rescue is restricted to owner DMs by default.",
        };
    }
    return {
        allowed: true,
        enabled: true,
        ownerDmOnly,
        pendingTtlMinutes,
        yolo: true,
        sandboxActive: false,
    };
}
