import { describe, expect, it } from "vitest";
import {
  createPostgresSessionStoreAdapter,
  type PostgresSessionStoreQueryClient,
  type PostgresSessionStoreQueryResult,
  type PostgresSessionStoreQueryRow,
} from "./postgres-store-adapter.js";

type QueryCall = { sql: string; values?: readonly unknown[] };

function createFakeClient(rowsByCall: Array<Array<Record<string, unknown>>> = []) {
  const calls: QueryCall[] = [];
  const client: PostgresSessionStoreQueryClient = {
    async query<TRow extends PostgresSessionStoreQueryRow = PostgresSessionStoreQueryRow>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<PostgresSessionStoreQueryResult<TRow>> {
      calls.push(values ? { sql, values } : { sql });
      return { rows: (rowsByCall.shift() ?? []) as TRow[], rowCount: 0 };
    },
  };
  return { client, calls };
}

describe("Postgres session store adapter", () => {
  it("loads and reads JSON session entries for one tenant/gateway/store", async () => {
    const { client, calls } = createFakeClient([
      [
        { session_key: "agent:main:main", entry_json: { sessionId: "sess-main", updatedAt: 2 } },
        { session_key: "global", entry_json: JSON.stringify({ sessionId: "sess-global" }) },
      ],
      [{ session_key: "global", entry_json: { sessionId: "sess-global" } }],
    ]);
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-producer",
    });

    await expect(adapter.loadStore("/state/type0/sessions.json")).resolves.toEqual({
      "agent:main:main": { sessionId: "sess-main", updatedAt: 2 },
      global: { sessionId: "sess-global" },
    });
    await expect(adapter.readEntry("/state/type0/sessions.json", "global")).resolves.toEqual({
      sessionId: "sess-global",
    });
    expect(calls[0]?.sql).toContain('FROM "openclaw"."openclaw_sessions"');
    expect(calls[0]?.values).toEqual(["type0", "type0-producer", "/state/type0/sessions.json"]);
    expect(calls[1]?.sql).toContain("session_key = ANY($4::text[])");
    expect(calls[1]?.values).toEqual([
      "type0",
      "type0-producer",
      "/state/type0/sessions.json",
      ["global"],
    ]);
  });

  it("uses bounded ordered list SQL and exposes pagination metadata", async () => {
    const { client, calls } = createFakeClient([
      [
        {
          session_key: "agent:main:two",
          entry_json: { sessionId: "sess-two", updatedAt: 200 },
          total_count: "3",
        },
      ],
    ]);
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-publisher",
      schema: "type0_sessions",
    });

    await expect(
      adapter.listEntries("/state/publisher/sessions.json", {
        keys: ["agent:main:one", "agent:main:two"],
        excludeKeys: ["global", "unknown"],
        label: "focus",
        spawnedBy: "agent:main:parent",
        search: "gpt_4%literal",
        updatedAfter: 100,
        limit: 1,
        offset: 1,
        orderBy: "updatedAt_asc",
      }),
    ).resolves.toEqual({
      entries: [["agent:main:two", { sessionId: "sess-two", updatedAt: 200 }]],
      totalCount: 3,
      limitApplied: 1,
      offset: 1,
      nextOffset: 2,
      hasMore: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('FROM "type0_sessions"."openclaw_sessions"');
    expect(calls[0]?.sql).toContain("NOT (session_key = ANY($5::text[]))");
    expect(calls[0]?.sql).toContain("entry_json->>'label' = $6");
    expect(calls[0]?.sql).toContain(
      "(entry_json->>'spawnedBy' = $7 OR entry_json->>'parentSessionKey' = $7)",
    );
    expect(calls[0]?.sql).toContain("LIKE $8 ESCAPE");
    expect(calls[0]?.sql).toContain(
      "ORDER BY updated_at_ms ASC, session_key ASC LIMIT $10 OFFSET $11",
    );
    expect(calls[0]?.values).toEqual([
      "type0",
      "type0-publisher",
      "/state/publisher/sessions.json",
      ["agent:main:one", "agent:main:two"],
      ["global", "unknown"],
      "focus",
      "agent:main:parent",
      "%gpt\\_4\\%literal%",
      100,
      1,
      1,
    ]);
  });

  it("preserves session totalCount when the requested page is past the end", async () => {
    const { client, calls } = createFakeClient([[], [{ total_count: "3" }]]);
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-publisher",
      schema: "type0_sessions",
    });

    await expect(
      adapter.listEntries("/state/publisher/sessions.json", {
        limit: 1,
        offset: 99,
        orderBy: "updatedAt_desc",
      }),
    ).resolves.toEqual({
      entries: [],
      totalCount: 3,
      limitApplied: 1,
      offset: 99,
      hasMore: false,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain(
      "ORDER BY updated_at_ms DESC, session_key ASC LIMIT $4 OFFSET $5",
    );
    expect(calls[0]?.values).toEqual([
      "type0",
      "type0-publisher",
      "/state/publisher/sessions.json",
      1,
      99,
    ]);
    expect(calls[1]?.sql).toContain(
      'SELECT count(*) AS total_count FROM "type0_sessions"."openclaw_sessions"',
    );
    expect(calls[1]?.sql).not.toContain("ORDER BY");
    expect(calls[1]?.values).toEqual([
      "type0",
      "type0-publisher",
      "/state/publisher/sessions.json",
    ]);
  });

  it("saves whole-store replacements in one transaction with deterministic upserts", async () => {
    const { client, calls } = createFakeClient();
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-audit",
      defaultAgentId: "audit",
    });

    await adapter.saveStore("/state/audit/sessions.json", {
      "agent:audit:two": { sessionId: "sess-two", updatedAt: 2 },
      "agent:audit:one": { sessionId: "sess-one", updatedAt: 1 },
    });

    expect(calls.map((call) => call.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      'INSERT INTO "openclaw"."openclaw_session_tenants"',
      'INSERT INTO "openclaw"."openclaw_session_gateways"',
      'INSERT INTO "openclaw"."openclaw_session_agents"',
      'DELETE FROM "openclaw"."openclaw_sessions"',
      'INSERT INTO "openclaw"."openclaw_sessions"',
      'INSERT INTO "openclaw"."openclaw_sessions"',
      "COMMIT",
    ]);
    expect(calls[4]?.values).toEqual([
      "type0",
      "type0-audit",
      "/state/audit/sessions.json",
      ["agent:audit:one", "agent:audit:two"],
    ]);
    expect(calls[5]?.values).toEqual([
      "type0",
      "type0-audit",
      "audit",
      "/state/audit/sessions.json",
      "agent:audit:one",
      "sess-one",
      1,
      JSON.stringify({ sessionId: "sess-one", updatedAt: 1 }),
    ]);
    expect(calls[5]?.sql).toContain("ON CONFLICT (tenant_id, gateway_id, store_path, session_key)");
  });

  it("updates by loading, mutating, and saving through the adapter", async () => {
    const { client, calls } = createFakeClient([
      [{ session_key: "agent:main:main", entry_json: { sessionId: "sess-main", updatedAt: 1 } }],
    ]);
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-producer",
    });

    await expect(
      adapter.updateStore("/state/type0/sessions.json", (store) => {
        store["agent:main:main"] = { ...store["agent:main:main"], updatedAt: 3 };
        return store["agent:main:main"]?.updatedAt;
      }),
    ).resolves.toBe(3);
    expect(calls.map((call) => call.sql.trim().split(/\s+/)[0])).toEqual([
      "SELECT",
      "BEGIN",
      "INSERT",
      "INSERT",
      "INSERT",
      "DELETE",
      "INSERT",
      "COMMIT",
    ]);
  });

  it("upserts entry batches without issuing whole-store deletes", async () => {
    const { client, calls } = createFakeClient();
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-producer",
    });

    await adapter.writeEntries?.("/state/type0/sessions.json", [
      ["agent:main:one", { sessionId: "sess-one", updatedAt: 1 }],
      ["agent:main:two", { sessionId: "sess-two", updatedAt: 2 }],
    ]);

    expect(calls.map((call) => call.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      'INSERT INTO "openclaw"."openclaw_session_tenants"',
      'INSERT INTO "openclaw"."openclaw_session_gateways"',
      'INSERT INTO "openclaw"."openclaw_session_agents"',
      'INSERT INTO "openclaw"."openclaw_sessions"',
      'INSERT INTO "openclaw"."openclaw_sessions"',
      "COMMIT",
    ]);
    expect(calls.some((call) => call.sql.includes("DELETE FROM"))).toBe(false);
    expect(calls[4]?.sql).toContain("ON CONFLICT (tenant_id, gateway_id, store_path, session_key)");
    expect(calls[4]?.sql).toContain("agent_id = EXCLUDED.agent_id");
  });

  it("marks selected entries deleted without loading or replacing the whole store", async () => {
    const { client, calls } = createFakeClient();
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-producer",
    });

    await adapter.deleteEntries?.("/state/type0/sessions.json", [
      "agent:main:legacy",
      "agent:main:stale",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('UPDATE "openclaw"."openclaw_sessions"');
    expect(calls[0]?.sql).toContain("SET deleted_at = now(), updated_at = now()");
    expect(calls[0]?.sql).toContain("session_key = ANY($4::text[])");
    expect(calls[0]?.values).toEqual([
      "type0",
      "type0-producer",
      "/state/type0/sessions.json",
      ["agent:main:legacy", "agent:main:stale"],
    ]);
  });

  it("upserts transcript chunks through the Postgres chunk table", async () => {
    const { client, calls } = createFakeClient();
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-audit",
      defaultAgentId: "audit",
    });

    await adapter.writeTranscriptChunks?.(
      "/state/audit/sessions.json",
      "agent:audit:main",
      [
        {
          chunkSeq: 0,
          transcriptPath: "/state/audit/sessions/session.jsonl",
          contentSha256: "abc123",
          bytes: 42,
          chunkJson: { version: 1, startLine: 1, endLine: 2, lines: [{ type: "session" }] },
        },
      ],
      { agentId: "audit" },
    );

    expect(calls.map((call) => call.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      'INSERT INTO "openclaw"."openclaw_session_tenants"',
      'INSERT INTO "openclaw"."openclaw_session_gateways"',
      'INSERT INTO "openclaw"."openclaw_session_agents"',
      'INSERT INTO "openclaw"."openclaw_transcript_chunks"',
      "COMMIT",
    ]);
    expect(calls[4]?.values).toEqual([
      "type0",
      "type0-audit",
      "audit",
      "/state/audit/sessions.json",
      "agent:audit:main",
      0,
      "/state/audit/sessions/session.jsonl",
      "abc123",
      42,
      JSON.stringify({ version: 1, startLine: 1, endLine: 2, lines: [{ type: "session" }] }),
    ]);
    expect(calls[4]?.sql).toContain(
      "ON CONFLICT (tenant_id, gateway_id, store_path, session_key, chunk_seq)",
    );
  });

  it("lists transcript chunks through a bounded ordered Postgres query", async () => {
    const { client, calls } = createFakeClient([
      [
        {
          chunk_seq: "2",
          transcript_path: "/state/audit/sessions/session.jsonl",
          content_sha256: "def456",
          bytes: 64,
          chunk_json: JSON.stringify({
            version: 1,
            startLine: 3,
            endLine: 4,
            lines: [{ type: "message" }],
          }),
          total_count: "3",
        },
      ],
    ]);
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-audit",
      schema: "type0_sessions",
    });

    await expect(
      adapter.listTranscriptChunks?.("/state/audit/sessions.json", "agent:audit:main", {
        transcriptPath: "/state/audit/sessions/session.jsonl",
        limit: 1,
        offset: 1,
        orderBy: "chunkSeq_desc",
      }),
    ).resolves.toEqual({
      chunks: [
        {
          chunkSeq: 2,
          transcriptPath: "/state/audit/sessions/session.jsonl",
          contentSha256: "def456",
          bytes: 64,
          chunkJson: {
            version: 1,
            startLine: 3,
            endLine: 4,
            lines: [{ type: "message" }],
          },
        },
      ],
      totalCount: 3,
      limitApplied: 1,
      offset: 1,
      nextOffset: 2,
      hasMore: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('FROM "type0_sessions"."openclaw_transcript_chunks"');
    expect(calls[0]?.sql).toContain(
      "WHERE tenant_id = $1 AND gateway_id = $2 AND store_path = $3 AND session_key = $4 AND transcript_path = $5",
    );
    expect(calls[0]?.sql).toContain("ORDER BY chunk_seq DESC LIMIT $6 OFFSET $7");
    expect(calls[0]?.values).toEqual([
      "type0",
      "type0-audit",
      "/state/audit/sessions.json",
      "agent:audit:main",
      "/state/audit/sessions/session.jsonl",
      1,
      1,
    ]);
  });

  it("preserves transcript chunk totalCount when the requested page is past the end", async () => {
    const { client, calls } = createFakeClient([[], [{ total_count: "3" }]]);
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-audit",
      schema: "type0_sessions",
    });

    await expect(
      adapter.listTranscriptChunks?.("/state/audit/sessions.json", "agent:audit:main", {
        transcriptPath: "/state/audit/sessions/session.jsonl",
        limit: 1,
        offset: 99,
      }),
    ).resolves.toEqual({
      chunks: [],
      totalCount: 3,
      limitApplied: 1,
      offset: 99,
      hasMore: false,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain("ORDER BY chunk_seq ASC LIMIT $6 OFFSET $7");
    expect(calls[0]?.values).toEqual([
      "type0",
      "type0-audit",
      "/state/audit/sessions.json",
      "agent:audit:main",
      "/state/audit/sessions/session.jsonl",
      1,
      99,
    ]);
    expect(calls[1]?.sql).toContain('FROM "type0_sessions"."openclaw_transcript_chunks"');
    expect(calls[1]?.sql).not.toContain("ORDER BY");
    expect(calls[1]?.values).toEqual([
      "type0",
      "type0-audit",
      "/state/audit/sessions.json",
      "agent:audit:main",
      "/state/audit/sessions/session.jsonl",
    ]);
  });

  it("upserts session turns through the Postgres turns table", async () => {
    const { client, calls } = createFakeClient();
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-producer",
      defaultAgentId: "producer",
    });

    await adapter.writeSessionTurns?.(
      "/state/producer/sessions.json",
      "agent:producer:main",
      [
        {
          turnSeq: 7,
          role: "assistant",
          modelProvider: "openai",
          model: "gpt-4.1",
          inputTokens: 123,
          outputTokens: 45,
          startedAt: "2026-05-26T12:00:00.000Z",
          endedAt: "2026-05-26T12:00:05.000Z",
          metadataJson: { source: "fixture" },
        },
      ],
      { agentId: "producer" },
    );

    expect(calls.map((call) => call.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      'INSERT INTO "openclaw"."openclaw_session_tenants"',
      'INSERT INTO "openclaw"."openclaw_session_gateways"',
      'INSERT INTO "openclaw"."openclaw_session_agents"',
      'INSERT INTO "openclaw"."openclaw_session_turns"',
      "COMMIT",
    ]);
    expect(calls[4]?.sql).toContain(
      "ON CONFLICT (tenant_id, gateway_id, store_path, session_key, turn_seq)",
    );
    expect(calls[4]?.values).toEqual([
      "type0",
      "type0-producer",
      "producer",
      "/state/producer/sessions.json",
      "agent:producer:main",
      7,
      "assistant",
      "openai",
      "gpt-4.1",
      123,
      45,
      "2026-05-26T12:00:00.000Z",
      "2026-05-26T12:00:05.000Z",
      JSON.stringify({ source: "fixture" }),
    ]);
  });

  it("lists session turns through a bounded ordered Postgres query", async () => {
    const { client, calls } = createFakeClient([
      [
        {
          turn_seq: "7",
          role: "assistant",
          model_provider: "openai",
          model: "gpt-4.1",
          input_tokens: "123",
          output_tokens: "45",
          started_at: "2026-05-26 12:00:00+00",
          ended_at: "2026-05-26 12:00:05+00",
          metadata_json: JSON.stringify({ source: "fixture" }),
          total_count: "9",
        },
      ],
    ]);
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-producer",
      schema: "type0_sessions",
    });

    await expect(
      adapter.listSessionTurns?.("/state/producer/sessions.json", "agent:producer:main", {
        limit: 1,
        offset: 3,
        orderBy: "turnSeq_desc",
      }),
    ).resolves.toEqual({
      turns: [
        {
          turnSeq: 7,
          role: "assistant",
          modelProvider: "openai",
          model: "gpt-4.1",
          inputTokens: 123,
          outputTokens: 45,
          startedAt: "2026-05-26 12:00:00+00",
          endedAt: "2026-05-26 12:00:05+00",
          metadataJson: { source: "fixture" },
        },
      ],
      totalCount: 9,
      limitApplied: 1,
      offset: 3,
      nextOffset: 4,
      hasMore: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('FROM "type0_sessions"."openclaw_session_turns"');
    expect(calls[0]?.sql).toContain(
      "WHERE tenant_id = $1 AND gateway_id = $2 AND store_path = $3 AND session_key = $4",
    );
    expect(calls[0]?.sql).toContain("ORDER BY turn_seq DESC LIMIT $5 OFFSET $6");
    expect(calls[0]?.values).toEqual([
      "type0",
      "type0-producer",
      "/state/producer/sessions.json",
      "agent:producer:main",
      1,
      3,
    ]);
  });

  it("preserves session turn totalCount when the requested page is past the end", async () => {
    const { client, calls } = createFakeClient([[], [{ total_count: "9" }]]);
    const adapter = createPostgresSessionStoreAdapter(client, {
      tenantId: "type0",
      gatewayId: "type0-producer",
      schema: "type0_sessions",
    });

    await expect(
      adapter.listSessionTurns?.("/state/producer/sessions.json", "agent:producer:main", {
        limit: 1,
        offset: 99,
      }),
    ).resolves.toEqual({
      turns: [],
      totalCount: 9,
      limitApplied: 1,
      offset: 99,
      hasMore: false,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain("ORDER BY turn_seq ASC LIMIT $5 OFFSET $6");
    expect(calls[0]?.values).toEqual([
      "type0",
      "type0-producer",
      "/state/producer/sessions.json",
      "agent:producer:main",
      1,
      99,
    ]);
    expect(calls[1]?.sql).toContain('FROM "type0_sessions"."openclaw_session_turns"');
    expect(calls[1]?.sql).not.toContain("ORDER BY");
    expect(calls[1]?.values).toEqual([
      "type0",
      "type0-producer",
      "/state/producer/sessions.json",
      "agent:producer:main",
    ]);
  });
});
