import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { listSpawnedSessionKeys, resolveInternalSessionKey, resolveMainSessionAlias, } from "./sessions-resolution.js";
export function resolveSessionToolsVisibility(cfg) {
    const raw = cfg.tools?.sessions
        ?.visibility;
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (value === "self" || value === "tree" || value === "agent" || value === "all") {
        return value;
    }
    return "tree";
}
export function resolveEffectiveSessionToolsVisibility(params) {
    const visibility = resolveSessionToolsVisibility(params.cfg);
    if (!params.sandboxed) {
        return visibility;
    }
    const sandboxClamp = params.cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
    if (sandboxClamp === "spawned" && visibility !== "tree") {
        return "tree";
    }
    return visibility;
}
export function resolveSandboxSessionToolsVisibility(cfg) {
    return cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
}
export function resolveSandboxedSessionToolContext(params) {
    const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
    const visibility = resolveSandboxSessionToolsVisibility(params.cfg);
    const requesterInternalKey = typeof params.agentSessionKey === "string" && params.agentSessionKey.trim()
        ? resolveInternalSessionKey({
            key: params.agentSessionKey,
            alias,
            mainKey,
        })
        : undefined;
    const effectiveRequesterKey = requesterInternalKey ?? alias;
    const restrictToSpawned = params.sandboxed === true &&
        visibility === "spawned" &&
        !!requesterInternalKey &&
        !isSubagentSessionKey(requesterInternalKey);
    return {
        mainKey,
        alias,
        visibility,
        requesterInternalKey,
        effectiveRequesterKey,
        restrictToSpawned,
    };
}
export function createAgentToAgentPolicy(cfg) {
    const routingA2A = cfg.tools?.agentToAgent;
    const enabled = routingA2A?.enabled === true;
    const allowPatterns = Array.isArray(routingA2A?.allow) ? routingA2A.allow : [];
    const matchesAllow = (agentId) => {
        if (allowPatterns.length === 0) {
            return true;
        }
        return allowPatterns.some((pattern) => {
            const raw = String(pattern ?? "").trim();
            if (!raw) {
                return false;
            }
            if (raw === "*") {
                return true;
            }
            if (!raw.includes("*")) {
                return raw === agentId;
            }
            const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`, "i");
            return re.test(agentId);
        });
    };
    const isAllowed = (requesterAgentId, targetAgentId) => {
        if (requesterAgentId === targetAgentId) {
            return true;
        }
        if (!enabled) {
            return false;
        }
        return matchesAllow(requesterAgentId) && matchesAllow(targetAgentId);
    };
    return { enabled, matchesAllow, isAllowed };
}
function actionPrefix(action) {
    if (action === "history") {
        return "Session history";
    }
    if (action === "send") {
        return "Session send";
    }
    return "Session list";
}
function a2aDisabledMessage(action) {
    if (action === "history") {
        return "Agent-to-agent history is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.";
    }
    if (action === "send") {
        return "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.";
    }
    return "Agent-to-agent listing is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent visibility.";
}
function a2aDeniedMessage(action) {
    if (action === "history") {
        return "Agent-to-agent history denied by tools.agentToAgent.allow.";
    }
    if (action === "send") {
        return "Agent-to-agent messaging denied by tools.agentToAgent.allow.";
    }
    return "Agent-to-agent listing denied by tools.agentToAgent.allow.";
}
function crossVisibilityMessage(action) {
    if (action === "history") {
        return "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
    }
    if (action === "send") {
        return "Session send visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
    }
    return "Session list visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
}
function selfVisibilityMessage(action) {
    return `${actionPrefix(action)} visibility is restricted to the current session (tools.sessions.visibility=self).`;
}
function treeVisibilityMessage(action) {
    return `${actionPrefix(action)} visibility is restricted to the current session tree (tools.sessions.visibility=tree).`;
}
export async function createSessionVisibilityGuard(params) {
    const requesterAgentId = resolveAgentIdFromSessionKey(params.requesterSessionKey);
    const spawnedKeys = params.visibility === "tree"
        ? await listSpawnedSessionKeys({ requesterSessionKey: params.requesterSessionKey })
        : null;
    const check = (targetSessionKey) => {
        const targetAgentId = resolveAgentIdFromSessionKey(targetSessionKey);
        const isCrossAgent = targetAgentId !== requesterAgentId;
        if (isCrossAgent) {
            if (params.visibility !== "all") {
                return {
                    allowed: false,
                    status: "forbidden",
                    error: crossVisibilityMessage(params.action),
                };
            }
            if (!params.a2aPolicy.enabled) {
                return {
                    allowed: false,
                    status: "forbidden",
                    error: a2aDisabledMessage(params.action),
                };
            }
            if (!params.a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
                return {
                    allowed: false,
                    status: "forbidden",
                    error: a2aDeniedMessage(params.action),
                };
            }
            return { allowed: true };
        }
        if (params.visibility === "self" && targetSessionKey !== params.requesterSessionKey) {
            return {
                allowed: false,
                status: "forbidden",
                error: selfVisibilityMessage(params.action),
            };
        }
        if (params.visibility === "tree" &&
            targetSessionKey !== params.requesterSessionKey &&
            !spawnedKeys?.has(targetSessionKey)) {
            return {
                allowed: false,
                status: "forbidden",
                error: treeVisibilityMessage(params.action),
            };
        }
        return { allowed: true };
    };
    return { check };
}
