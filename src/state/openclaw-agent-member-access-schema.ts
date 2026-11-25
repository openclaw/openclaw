import type { DatabaseSync } from "node:sqlite";
import { isCompatibleAdditiveColumnDefinition } from "../infra/sqlite-additive-column.js";
import { AGENT_MEMBER_ACCESS_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export { AGENT_MEMBER_ACCESS_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
const memberAccessColumn =
  "access TEXT CHECK (access IS NULL OR access IN ('read', 'suggest', 'send'))";

export function getAgentMemberAccessMinReader(): number {
  return isCompatibleAdditiveColumnDefinition(memberAccessColumn)
    ? AGENT_MEMBER_ACCESS_SCHEMA_VERSION - 1
    : AGENT_MEMBER_ACCESS_SCHEMA_VERSION;
}

export function withoutAgentMemberAccess(schema: string): string {
  return schema.replace(`  ${memberAccessColumn},\n`, "");
}

export function withoutAgentPostgresMemberAccess(schema: string): string {
  return schema.replace(/(CREATE TABLE "session_members" \()[\s\S]*?\n\);/u, (table) =>
    table
      .replace('  "access" text COLLATE "C",\n', "")
      .replace(`,\n  CHECK ("access" IS NULL OR ("access" IN ('read', 'suggest', 'send')))`, ""),
  );
}

export function migrateAgentMemberAccessInTransaction(database: DatabaseSync): void {
  ensureColumn(database, "session_members", memberAccessColumn);
}

export const AGENT_MEMBER_ACCESS_POSTGRES_MIGRATION_SQL = `ALTER TABLE session_members ADD COLUMN ${memberAccessColumn.replace("TEXT", 'TEXT COLLATE "C"')};`;
