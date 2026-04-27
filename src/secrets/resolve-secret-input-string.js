import { normalizeSecretInputString, resolveSecretInputRef, } from "../config/types.secrets.js";
import { resolveSecretRefString } from "./resolve.js";
export async function resolveSecretInputString(params) {
    const normalize = params.normalize ?? normalizeSecretInputString;
    const { ref } = resolveSecretInputRef({
        value: params.value,
        defaults: params.defaults ?? params.config.secrets?.defaults,
    });
    if (!ref) {
        return normalize(params.value);
    }
    let resolved;
    try {
        resolved = await resolveSecretRefString(ref, {
            config: params.config,
            env: params.env,
        });
    }
    catch (error) {
        if (params.onResolveRefError) {
            return params.onResolveRefError(error, ref);
        }
        throw error;
    }
    return normalize(resolved);
}
