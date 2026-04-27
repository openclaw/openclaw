import { normalizeBaseCompatibilityConfigValues } from "./legacy-config-compatibility-base.js";
export function normalizeRuntimeCompatibilityConfigValues(cfg) {
    const changes = [];
    const next = normalizeBaseCompatibilityConfigValues(cfg, changes);
    return { config: next, changes };
}
