import { getCommandPathWithRootOptions } from "../cli/argv.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";
const requireConfig = resolveNodeRequireFromMeta(import.meta.url);
export function shouldSkipMutatingLoggingConfigRead(argv = process.argv) {
    const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
    return primary === "config" && (secondary === "schema" || secondary === "validate");
}
export function readLoggingConfig() {
    if (shouldSkipMutatingLoggingConfigRead()) {
        return undefined;
    }
    try {
        const loaded = requireConfig?.("../config/config.js");
        const parsed = loaded?.loadConfig?.();
        const logging = parsed?.logging;
        if (!logging || typeof logging !== "object" || Array.isArray(logging)) {
            return undefined;
        }
        return logging;
    }
    catch {
        return undefined;
    }
}
