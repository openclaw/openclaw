/** Destination versions, declared only with proof through the complete migration runner. */
export const SCHEMA_MIGRATION_BACKUP_TABLES: Record<
  "agent" | "state",
  Readonly<Partial<Record<number, readonly string[]>>>
> = {
  agent: {
    27: ["context_engine_turn_outbox", "sqlite_stat1", "sqlite_stat4"],
  },
  state: {},
};
