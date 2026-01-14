import { LEGACY_CONFIG_MIGRATIONS_PART_1 } from "./legacy.migrations.part-1.js";
import { LEGACY_CONFIG_MIGRATIONS_PART_2 } from "./legacy.migrations.part-2.js";
import { LEGACY_CONFIG_MIGRATIONS_PART_3 } from "./legacy.migrations.part-3.js";

export const LEGACY_CONFIG_MIGRATIONS = [
  ...LEGACY_CONFIG_MIGRATIONS_PART_1,
  ...LEGACY_CONFIG_MIGRATIONS_PART_2,
  ...LEGACY_CONFIG_MIGRATIONS_PART_3,
];
