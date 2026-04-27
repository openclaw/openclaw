import { collectSecretInputAssignment, } from "./runtime-shared.js";
import { isRecord } from "./shared.js";
function collectProviderApiKeyAssignment(params) {
    collectSecretInputAssignment({
        value: params.providerConfig.apiKey,
        path: `${params.pathPrefix}.providers.${params.providerId}.apiKey`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: params.active,
        inactiveReason: params.inactiveReason,
        apply: (value) => {
            params.providerConfig.apiKey = value;
        },
    });
}
export function collectTtsApiKeyAssignments(params) {
    const providers = params.tts.providers;
    if (isRecord(providers)) {
        for (const [providerId, providerConfig] of Object.entries(providers)) {
            if (!isRecord(providerConfig)) {
                continue;
            }
            collectProviderApiKeyAssignment({
                providerId,
                providerConfig,
                pathPrefix: params.pathPrefix,
                defaults: params.defaults,
                context: params.context,
                active: params.active,
                inactiveReason: params.inactiveReason,
            });
        }
        return;
    }
}
