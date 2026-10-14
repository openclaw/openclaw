/** Destination versions, declared only with proof through the complete migration runner. */
export const SCHEMA_MIGRATION_BACKUP_TABLES: Record<
  "agent" | "state",
  Readonly<Partial<Record<number, readonly string[]>>>
> = {
  agent: {},
  state: {},
};
