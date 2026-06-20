import { describe, expect, it } from "vitest";
import {
  OPENCLAW_SESSION_POSTGRES_SCHEMA_VERSION,
  OPENCLAW_SESSION_POSTGRES_TABLES,
  buildOpenClawSessionPostgresSchemaSql,
  qualifyPostgresSessionTable,
} from "./postgres-schema.js";

describe("OpenClaw Postgres session schema", () => {
  it("declares the durable Plan B table set", () => {
    expect(OPENCLAW_SESSION_POSTGRES_SCHEMA_VERSION).toBe(1);
    expect(OPENCLAW_SESSION_POSTGRES_TABLES).toEqual([
      "openclaw_session_tenants",
      "openclaw_session_gateways",
      "openclaw_session_agents",
      "openclaw_sessions",
      "openclaw_session_turns",
      "openclaw_transcript_chunks",
      "openclaw_session_leases",
      "openclaw_session_backpressure",
    ]);
  });

  it("builds tenant/gateway isolated DDL with store-path scoped session keys", () => {
    const sql = buildOpenClawSessionPostgresSchemaSql("type0_sessions");
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "type0_sessions"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "type0_sessions"."openclaw_sessions"');
    expect(sql).toContain("PRIMARY KEY (tenant_id, gateway_id, store_path, session_key)");
    expect(sql).toContain("openclaw_session_leases");
    expect(sql).toContain("openclaw_session_backpressure");
    expect(sql).toContain("openclaw_sessions_spawned_by_idx");
    expect(sql).toContain("openclaw_sessions_parent_key_idx");
    expect(sql).toContain("jsonb NOT NULL");
  });

  it("rejects unsafe schema identifiers", () => {
    expect(() => qualifyPostgresSessionTable("openclaw_sessions", "bad-name")).toThrow(
      "Invalid PostgreSQL identifier",
    );
  });
});
