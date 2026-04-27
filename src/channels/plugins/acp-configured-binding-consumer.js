import { buildConfiguredAcpSessionKey, normalizeBindingConfig, normalizeMode, normalizeText, parseConfiguredAcpSessionKey, toConfiguredAcpBindingRecord, } from "../../acp/persistent-bindings.types.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir, resolveDefaultAgentId, } from "../../agents/agent-scope.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, } from "../../shared/string-coerce.js";
function resolveAgentRuntimeAcpDefaults(params) {
    const ownerAgentId = normalizeLowercaseStringOrEmpty(params.ownerAgentId);
    const agent = params.cfg.agents?.list?.find((entry) => normalizeOptionalLowercaseString(entry.id) === ownerAgentId);
    if (!agent || agent.runtime?.type !== "acp") {
        return {};
    }
    return {
        acpAgentId: normalizeText(agent.runtime.acp?.agent),
        mode: normalizeText(agent.runtime.acp?.mode),
        cwd: normalizeText(agent.runtime.acp?.cwd),
        backend: normalizeText(agent.runtime.acp?.backend),
    };
}
function resolveConfiguredBindingWorkspaceCwd(params) {
    const explicitAgentWorkspace = normalizeText(resolveAgentConfig(params.cfg, params.agentId)?.workspace);
    if (explicitAgentWorkspace) {
        return resolveAgentWorkspaceDir(params.cfg, params.agentId);
    }
    if (params.agentId === resolveDefaultAgentId(params.cfg)) {
        const defaultWorkspace = normalizeText(params.cfg.agents?.defaults?.workspace);
        if (defaultWorkspace) {
            return resolveAgentWorkspaceDir(params.cfg, params.agentId);
        }
    }
    return undefined;
}
function buildConfiguredAcpSpec(params) {
    return {
        channel: params.channel,
        accountId: params.accountId,
        conversationId: params.conversation.conversationId,
        parentConversationId: params.conversation.parentConversationId,
        agentId: params.agentId,
        acpAgentId: params.acpAgentId,
        mode: params.mode,
        cwd: params.cwd,
        backend: params.backend,
        label: params.label,
    };
}
function buildAcpTargetFactory(params) {
    if (params.binding.type !== "acp") {
        return null;
    }
    const runtimeDefaults = resolveAgentRuntimeAcpDefaults({
        cfg: params.cfg,
        ownerAgentId: params.agentId,
    });
    const bindingOverrides = normalizeBindingConfig(params.binding.acp);
    const mode = normalizeMode(bindingOverrides.mode ?? runtimeDefaults.mode);
    const cwd = bindingOverrides.cwd ??
        runtimeDefaults.cwd ??
        resolveConfiguredBindingWorkspaceCwd({
            cfg: params.cfg,
            agentId: params.agentId,
        });
    const backend = bindingOverrides.backend ?? runtimeDefaults.backend;
    const label = bindingOverrides.label;
    const acpAgentId = normalizeText(runtimeDefaults.acpAgentId);
    return {
        driverId: "acp",
        materialize: ({ accountId, conversation }) => {
            const spec = buildConfiguredAcpSpec({
                channel: params.channel,
                accountId,
                conversation,
                agentId: params.agentId,
                acpAgentId,
                mode,
                cwd,
                backend,
                label,
            });
            const record = toConfiguredAcpBindingRecord(spec);
            return {
                record,
                statefulTarget: {
                    kind: "stateful",
                    driverId: "acp",
                    sessionKey: buildConfiguredAcpSessionKey(spec),
                    agentId: params.agentId,
                    ...(label ? { label } : {}),
                },
            };
        },
    };
}
export const acpConfiguredBindingConsumer = {
    id: "acp",
    supports: (binding) => binding.type === "acp",
    buildTargetFactory: (params) => buildAcpTargetFactory({
        cfg: params.cfg,
        binding: params.binding,
        channel: params.channel,
        agentId: params.agentId,
    }),
    parseSessionKey: ({ sessionKey }) => parseConfiguredAcpSessionKey(sessionKey),
    matchesSessionKey: ({ sessionKey, materializedTarget }) => materializedTarget.record.targetSessionKey === sessionKey,
};
