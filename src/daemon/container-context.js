import { normalizeOptionalString } from "../shared/string-coerce.js";
export function resolveDaemonContainerContext(env = process.env) {
    return (normalizeOptionalString(env.OPENCLAW_CONTAINER_HINT) ||
        normalizeOptionalString(env.OPENCLAW_CONTAINER) ||
        null);
}
