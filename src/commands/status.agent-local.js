import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { readSessionStoreReadOnly } from "../config/sessions/store-read.js";
import { listGatewayAgentsBasic } from "../gateway/agent-list.js";
async function fileExists(p) {
    try {
        await fs.access(p);
        return true;
    }
    catch {
        return false;
    }
}
export async function getAgentLocalStatuses(cfg) {
    const agentList = listGatewayAgentsBasic(cfg);
    const now = Date.now();
    const statuses = [];
    for (const agent of agentList.agents) {
        const agentId = agent.id;
        const workspaceDir = (() => {
            try {
                return resolveAgentWorkspaceDir(cfg, agentId);
            }
            catch {
                return null;
            }
        })();
        const bootstrapPath = workspaceDir != null ? path.join(workspaceDir, "BOOTSTRAP.md") : null;
        const bootstrapPending = bootstrapPath != null ? await fileExists(bootstrapPath) : null;
        const sessionsPath = resolveStorePath(cfg.session?.store, { agentId });
        const store = readSessionStoreReadOnly(sessionsPath);
        const sessions = Object.entries(store)
            .filter(([key]) => key !== "global" && key !== "unknown")
            .map(([, entry]) => entry);
        const sessionsCount = sessions.length;
        const lastUpdatedAt = sessions.reduce((max, e) => Math.max(max, e?.updatedAt ?? 0), 0);
        const resolvedLastUpdatedAt = lastUpdatedAt > 0 ? lastUpdatedAt : null;
        const lastActiveAgeMs = resolvedLastUpdatedAt ? now - resolvedLastUpdatedAt : null;
        statuses.push({
            id: agentId,
            name: agent.name,
            workspaceDir,
            bootstrapPending,
            sessionsPath,
            sessionsCount,
            lastUpdatedAt: resolvedLastUpdatedAt,
            lastActiveAgeMs,
        });
    }
    const totalSessions = statuses.reduce((sum, s) => sum + s.sessionsCount, 0);
    const bootstrapPendingCount = statuses.reduce((sum, s) => sum + (s.bootstrapPending ? 1 : 0), 0);
    return {
        defaultId: agentList.defaultId,
        agents: statuses,
        totalSessions,
        bootstrapPendingCount,
    };
}
