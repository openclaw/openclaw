import { normalizeSafeBinProfileFixtures } from "../infra/exec-safe-bin-policy.js";
import { normalizeTrustedSafeBinDirs } from "../infra/exec-safe-bin-trust.js";
export function normalizeExecSafeBinProfilesInConfig(cfg) {
    const normalizeExec = (exec) => {
        if (!exec || typeof exec !== "object" || Array.isArray(exec)) {
            return;
        }
        const typedExec = exec;
        const normalizedProfiles = normalizeSafeBinProfileFixtures(typedExec.safeBinProfiles);
        typedExec.safeBinProfiles =
            Object.keys(normalizedProfiles).length > 0 ? normalizedProfiles : undefined;
        const normalizedTrustedDirs = normalizeTrustedSafeBinDirs(typedExec.safeBinTrustedDirs);
        typedExec.safeBinTrustedDirs =
            normalizedTrustedDirs.length > 0 ? normalizedTrustedDirs : undefined;
    };
    normalizeExec(cfg.tools?.exec);
    const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
    for (const agent of agents) {
        normalizeExec(agent?.tools?.exec);
    }
}
