import { normalizeProviderId } from "../agents/model-selection.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
function matchesProviderId(candidate, providerId) {
    const normalized = normalizeProviderId(providerId);
    if (!normalized) {
        return false;
    }
    if (normalizeProviderId(candidate.id) === normalized) {
        return true;
    }
    return (candidate.aliases ?? []).some((alias) => normalizeProviderId(alias) === normalized);
}
export function resolveProviderAuthLoginCommand(params) {
    const provider = resolvePluginProviders({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        mode: "setup",
    }).find((candidate) => matchesProviderId(candidate, params.provider));
    if (!provider || provider.auth.length === 0) {
        return undefined;
    }
    return formatCliCommand(`openclaw models auth login --provider ${provider.id}`);
}
export function buildProviderAuthRecoveryHint(params) {
    const loginCommand = resolveProviderAuthLoginCommand(params);
    const parts = [];
    if (loginCommand) {
        parts.push(`Run \`${loginCommand}\``);
    }
    if (params.includeConfigure !== false) {
        parts.push(`\`${formatCliCommand("openclaw configure")}\``);
    }
    if (params.includeEnvVar) {
        parts.push("set an API key env var");
    }
    if (parts.length === 0) {
        return `Run \`${formatCliCommand("openclaw configure")}\`.`;
    }
    if (parts.length === 1) {
        return `${parts[0]}.`;
    }
    if (parts.length === 2) {
        return `${parts[0]} or ${parts[1]}.`;
    }
    return `${parts[0]}, ${parts[1]}, or ${parts[2]}.`;
}
