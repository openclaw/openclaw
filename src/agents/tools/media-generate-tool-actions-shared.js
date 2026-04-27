import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";
export function createMediaGenerateProviderListActionResult(params) {
    if (params.providers.length === 0) {
        return {
            content: [{ type: "text", text: params.emptyText }],
            details: { providers: [] },
        };
    }
    const lines = params.providers.map((provider) => {
        const authHints = getProviderEnvVars(provider.id);
        const capabilities = params.summarizeCapabilities(provider);
        return [
            `${provider.id}: default=${provider.defaultModel ?? "none"}`,
            provider.models?.length ? `models=${provider.models.join(", ")}` : null,
            capabilities ? `capabilities=${capabilities}` : null,
            authHints.length > 0 ? `auth=${authHints.join(" / ")}` : null,
        ]
            .filter((entry) => Boolean(entry))
            .join(" | ");
    });
    return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
            providers: params.providers.map((provider) => ({
                id: provider.id,
                defaultModel: provider.defaultModel,
                models: provider.models ?? [],
                modes: params.listModes(provider),
                authEnvVars: getProviderEnvVars(provider.id),
                capabilities: provider.capabilities,
            })),
        },
    };
}
export function createMediaGenerateTaskStatusActions(params) {
    return {
        createStatusActionResult(sessionKey) {
            return createMediaGenerateStatusActionResult({
                sessionKey,
                inactiveText: params.inactiveText,
                findActiveTask: params.findActiveTask,
                buildStatusText: params.buildStatusText,
                buildStatusDetails: params.buildStatusDetails,
            });
        },
        createDuplicateGuardResult(sessionKey) {
            return createMediaGenerateDuplicateGuardResult({
                sessionKey,
                findActiveTask: params.findActiveTask,
                buildStatusText: params.buildStatusText,
                buildStatusDetails: params.buildStatusDetails,
            });
        },
    };
}
export function createMediaGenerateStatusActionResult(params) {
    const activeTask = params.findActiveTask(params.sessionKey);
    if (!activeTask) {
        return {
            content: [{ type: "text", text: params.inactiveText }],
            details: {
                action: "status",
                active: false,
            },
        };
    }
    return {
        content: [{ type: "text", text: params.buildStatusText(activeTask) }],
        details: {
            action: "status",
            ...params.buildStatusDetails(activeTask),
        },
    };
}
export function createMediaGenerateDuplicateGuardResult(params) {
    const activeTask = params.findActiveTask(params.sessionKey);
    if (!activeTask) {
        return undefined;
    }
    return {
        content: [
            {
                type: "text",
                text: params.buildStatusText(activeTask, { duplicateGuard: true }),
            },
        ],
        details: {
            action: "status",
            duplicateGuard: true,
            ...params.buildStatusDetails(activeTask),
        },
    };
}
