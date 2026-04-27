import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS } from "../agents/sandbox/config.js";
import { collectPluginConfigContractMatches, resolvePluginConfigContractsById, } from "../plugins/config-contracts.js";
import { isRecord } from "../utils.js";
import { collectCoreInsecureOrDangerousFlags } from "./core-dangerous-config-flags.js";
function formatDangerousConfigFlagValue(value) {
    return value === null ? "null" : String(value);
}
function getAgentDangerousFlagPathSegment(agent, index) {
    const id = agent &&
        typeof agent === "object" &&
        !Array.isArray(agent) &&
        typeof agent.id === "string" &&
        agent.id.length > 0
        ? agent.id
        : undefined;
    return id ? `agents.list[id=${JSON.stringify(id)}]` : `agents.list[${index}]`;
}
export function collectEnabledInsecureOrDangerousFlags(cfg) {
    const enabledFlags = collectCoreInsecureOrDangerousFlags(cfg);
    const collectSandboxDockerDangerousFlags = (docker, pathPrefix) => {
        if (!isRecord(docker)) {
            return;
        }
        for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) {
            if (docker[key] === true) {
                enabledFlags.push(`${pathPrefix}.${key}=true`);
            }
        }
    };
    if (cfg.hooks?.allowRequestSessionKey === true) {
        enabledFlags.push("hooks.allowRequestSessionKey=true");
    }
    if (cfg.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork === true) {
        enabledFlags.push("browser.ssrfPolicy.dangerouslyAllowPrivateNetwork=true");
    }
    if (cfg.tools?.fs?.workspaceOnly === false) {
        enabledFlags.push("tools.fs.workspaceOnly=false");
    }
    collectSandboxDockerDangerousFlags(isRecord(cfg.agents?.defaults?.sandbox?.docker)
        ? cfg.agents?.defaults?.sandbox?.docker
        : undefined, "agents.defaults.sandbox.docker");
    if (Array.isArray(cfg.agents?.list)) {
        for (const [index, agent] of cfg.agents.list.entries()) {
            collectSandboxDockerDangerousFlags(isRecord(agent?.sandbox?.docker) ? agent.sandbox.docker : undefined, `${getAgentDangerousFlagPathSegment(agent, index)}.sandbox.docker`);
        }
    }
    const pluginEntries = cfg.plugins?.entries;
    if (!isRecord(pluginEntries)) {
        return enabledFlags;
    }
    const configContracts = resolvePluginConfigContractsById({
        config: cfg,
        workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
        env: process.env,
        cache: true,
        pluginIds: Object.keys(pluginEntries),
    });
    const seenFlags = new Set();
    for (const [pluginId, metadata] of configContracts.entries()) {
        const dangerousFlags = metadata.configContracts.dangerousFlags;
        if (!dangerousFlags?.length) {
            continue;
        }
        const pluginEntry = pluginEntries[pluginId];
        if (!isRecord(pluginEntry) || !isRecord(pluginEntry.config)) {
            continue;
        }
        for (const flag of dangerousFlags) {
            for (const match of collectPluginConfigContractMatches({
                root: pluginEntry.config,
                pathPattern: flag.path,
            })) {
                if (!Object.is(match.value, flag.equals)) {
                    continue;
                }
                const rendered = `plugins.entries.${pluginId}.config.${match.path}` +
                    `=${formatDangerousConfigFlagValue(flag.equals)}`;
                if (seenFlags.has(rendered)) {
                    continue;
                }
                seenFlags.add(rendered);
                enabledFlags.push(rendered);
            }
        }
    }
    return enabledFlags;
}
