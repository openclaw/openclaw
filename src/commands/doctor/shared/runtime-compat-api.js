import { isDeepStrictEqual } from "node:util";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { normalizeRuntimeCompatibilityConfigValues } from "./legacy-config-runtime-migrate.js";
export function applyRuntimeLegacyConfigMigrations(raw) {
    if (!raw || typeof raw !== "object") {
        return { next: null, changes: [] };
    }
    const original = raw;
    const migrated = applyLegacyDoctorMigrations(original);
    const base = (migrated.next ?? original);
    const normalized = normalizeRuntimeCompatibilityConfigValues(base);
    const next = normalized.config;
    const changes = [...migrated.changes, ...normalized.changes];
    if (changes.length === 0 || isDeepStrictEqual(next, original)) {
        return { next: null, changes: [] };
    }
    return { next, changes };
}
