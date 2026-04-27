import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";
export function applyLegacyDoctorMigrations(raw) {
    if (!raw || typeof raw !== "object") {
        return { next: null, changes: [] };
    }
    const original = raw;
    const next = structuredClone(original);
    const changes = [];
    for (const migration of LEGACY_CONFIG_MIGRATIONS) {
        migration.apply(next, changes);
    }
    const compat = applyChannelDoctorCompatibilityMigrations(next);
    changes.push(...compat.changes);
    if (changes.length === 0) {
        return { next: null, changes: [] };
    }
    return { next: compat.next, changes };
}
