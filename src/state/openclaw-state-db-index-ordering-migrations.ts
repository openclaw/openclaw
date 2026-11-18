export const stateIndexOrderingMigrations = [
  {
    version: 32,
    tables: [],
    columns: [],
    migrate: () => false,
    applied: "Aligned PostgreSQL non-null index ordering (v32)",
  },
  {
    version: 33,
    tables: [],
    columns: [],
    migrate: () => false,
    applied: "Aligned PostgreSQL partial-index ordering (v33)",
  },
];
