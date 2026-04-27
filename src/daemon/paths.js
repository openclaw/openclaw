import path from "node:path";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveGatewayProfileSuffix } from "./constants.js";
const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;
export function resolveHomeDir(env) {
    const home = normalizeOptionalString(env.HOME) || normalizeOptionalString(env.USERPROFILE);
    if (!home) {
        throw new Error("Missing HOME");
    }
    return home;
}
export function resolveUserPathWithHome(input, home) {
    const trimmed = input.trim();
    if (!trimmed) {
        return trimmed;
    }
    if (trimmed.startsWith("~")) {
        if (!home) {
            throw new Error("Missing HOME");
        }
        const expanded = trimmed.replace(/^~(?=$|[\\/])/, home);
        return path.resolve(expanded);
    }
    if (windowsAbsolutePath.test(trimmed) || windowsUncPath.test(trimmed)) {
        return trimmed;
    }
    return path.resolve(trimmed);
}
export function resolveGatewayStateDir(env) {
    const override = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
    if (override) {
        const home = override.startsWith("~") ? resolveHomeDir(env) : undefined;
        return resolveUserPathWithHome(override, home);
    }
    const home = resolveHomeDir(env);
    const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE);
    return path.join(home, `.openclaw${suffix}`);
}
