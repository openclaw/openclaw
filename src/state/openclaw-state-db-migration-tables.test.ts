import { expect, it } from "vitest";
import { getCanonicalSqliteTableNames } from "../infra/sqlite-schema-contract.js";
import { STATE_SCHEMA_MIGRATION_DESCRIPTIONS } from "./openclaw-state-db-contract.js";
import { STATE_SCHEMA_MIGRATION_READ_TABLES } from "./openclaw-state-db-schema-repair.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

it("declares a read-contract table set for every shared-state migration", () => {
  expect(Object.keys(STATE_SCHEMA_MIGRATION_READ_TABLES).toSorted()).toEqual(
    Object.keys(STATE_SCHEMA_MIGRATION_DESCRIPTIONS).toSorted(),
  );
});

it("includes every canonical table in the STRICT migration's read contract", () => {
  expect(STATE_SCHEMA_MIGRATION_READ_TABLES["strict-tables-v3"].toSorted()).toEqual(
    getCanonicalSqliteTableNames(OPENCLAW_STATE_SCHEMA_SQL).toSorted(),
  );
});
