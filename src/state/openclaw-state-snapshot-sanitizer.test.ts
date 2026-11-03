import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSocket, type ApprovalRow } from "../infra/client-credential-migration-data.js";
import { sanitizeOpenClawGlobalStateSnapshot } from "./openclaw-state-snapshot-sanitizer.js";

describe("OpenClaw state snapshot sanitizer", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE exec_approvals_config (
        config_key TEXT PRIMARY KEY,
        raw_json TEXT NOT NULL,
        socket_path TEXT,
        has_socket_token INTEGER NOT NULL,
        default_security TEXT,
        default_ask TEXT,
        default_ask_fallback TEXT,
        auto_allow_skills INTEGER,
        agent_count INTEGER NOT NULL,
        allowlist_count INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
  });

  afterEach(() => database.close());

  function sanitizePolicy(
    raw: string,
    staleMetadata: SQLInputValue[] = ["full", "always", "full", 1, 9, 9],
  ) {
    database
      .prepare(
        `INSERT INTO exec_approvals_config (
          config_key, raw_json, socket_path, has_socket_token,
          default_security, default_ask, default_ask_fallback, auto_allow_skills,
          agent_count, allowlist_count, updated_at_ms
        ) VALUES (?, ?, '/stale.sock', 1, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run("current", raw, ...staleMetadata);
    sanitizeOpenClawGlobalStateSnapshot(database);
    return database
      .prepare("SELECT * FROM exec_approvals_config WHERE config_key = 'current'")
      .get() as ApprovalRow;
  }

  it("redacts the exec approvals socket token without dropping policy", () => {
    const raw = JSON.stringify({
      version: 1,
      socket: { path: "/tmp/exec.sock", token: "secret-token" },
      defaults: { security: "allowlist" },
      agents: {},
    });
    const row = sanitizePolicy(raw);
    expect(row).toMatchObject({
      socket_path: "/tmp/exec.sock",
      has_socket_token: 0,
      default_security: "allowlist",
      default_ask: null,
      default_ask_fallback: null,
      auto_allow_skills: null,
      agent_count: 0,
      allowlist_count: 0,
    });
    expect(JSON.parse(row.raw_json)).toEqual({
      version: 1,
      socket: { path: "/tmp/exec.sock" },
      defaults: { security: "allowlist" },
      agents: {},
    });
    expect(row.raw_json).not.toContain("secret-token");
    const migrated = extractSocket(row);
    expect(migrated.socket).toEqual({
      socket_key: "current",
      socket_path: "/tmp/exec.sock",
      socket_token: null,
      updated_at_ms: 1,
    });
    expect(JSON.parse(migrated.policy!)).toEqual({
      version: 1,
      defaults: { security: "allowlist" },
      agents: {},
    });
  });

  it("keeps a supported older exec approval policy instead of replacing it with deny-all", () => {
    const raw = JSON.stringify({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss" },
      agents: {
        default: {
          allowlist: [{ pattern: "/usr/bin/printf", commandText: "printf hello" }],
        },
      },
    });
    const row = sanitizePolicy(raw, ["deny", "off", "deny", 0, 0, 0]);
    expect(row).toMatchObject({
      default_security: "allowlist",
      default_ask: "on-miss",
      agent_count: 1,
      allowlist_count: 1,
    });
    const restored = JSON.parse(row.raw_json) as {
      defaults: { security: string; ask: string };
      agents: Record<string, { allowlist: { pattern: string }[] }>;
    };
    expect(restored.defaults).toMatchObject({ security: "allowlist", ask: "on-miss" });
    expect(restored.agents.main?.allowlist.map((entry) => entry.pattern)).toEqual([
      "/usr/bin/printf",
    ]);
  });

  it.each([
    ["invalid JSON", "{malformed-secret-token", "secret-token"],
    [
      "invalid structure",
      JSON.stringify({ version: 1, socket: [{ token: "nested-secret-token" }], agents: {} }),
      "nested-secret-token",
    ],
  ])("replaces %s policy with a fail-closed secret-free document", (_label, raw, secret) => {
    const row = sanitizePolicy(raw);
    expect(row).toMatchObject({
      socket_path: null,
      has_socket_token: 0,
      default_security: "deny",
      default_ask: "off",
      default_ask_fallback: "deny",
      auto_allow_skills: 0,
      agent_count: 0,
      allowlist_count: 0,
    });
    expect(JSON.parse(row.raw_json).defaults).toMatchObject({ security: "deny", ask: "off" });
    expect(row.raw_json).not.toContain(secret);
  });
});
