import { applyLegacyDoctorMigrations } from "./legacy-config-migrate.js";

export function applyRuntimeLegacyConfigMigrations(raw: unknown): {
  next: Record<string, unknown> | null;
  changes: string[];
} {
  return applyLegacyDoctorMigrations(raw);
}
