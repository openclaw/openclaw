/**
 * ULS Policy & ACL Enforcement — Unit Tests
 */

import { describe, expect, it } from "vitest";
import { canWriteAtScope, canReadRecord, validateSchemaVersion } from "./policy.js";
import type { UlsConfig, UlsRecord } from "./types.js";
import { ULS_SCHEMA_VERSION, DEFAULT_ULS_CONFIG } from "./types.js";

function makeConfig(overrides?: Partial<UlsConfig>): UlsConfig {
  return {
    ...DEFAULT_ULS_CONFIG,
    enabled: true,
    storagePath: "/tmp/uls-test",
    ...overrides,
  };
}

function makeRecord(overrides?: Partial<UlsRecord>): UlsRecord {
  return {
    schemaVersion: ULS_SCHEMA_VERSION,
    recordId: "rec-1",
    agentId: "agent-a",
    timestamp: Date.now(),
    modality: "tool_result",
    ut: {},
    pPublic: { summary: "test" },
    tags: [],
    riskFlags: [],
    scope: "global",
    acl: {},
    provenance: { inputHash: "abc123" },
    ...overrides,
  };
}

describe("canWriteAtScope", () => {
  it("always allows self scope", () => {
    const config = makeConfig();
    expect(canWriteAtScope("agent-a", "self", config).allowed).toBe(true);
  });

  it("denies team scope if agent has no allowed scopes", () => {
    const config = makeConfig();
    const result = canWriteAtScope("agent-a", "team", config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not authorized");
  });

  it("allows team scope if explicitly configured", () => {
    const config = makeConfig({
      allowedScopes: { "agent-a": ["self", "team"] },
      teamGroups: { devs: ["agent-a", "agent-b"] },
    });
    expect(canWriteAtScope("agent-a", "team", config).allowed).toBe(true);
  });

  it("denies team scope if agent is in allowed but not in any team group", () => {
    const config = makeConfig({
      allowedScopes: { "agent-a": ["self", "team"] },
      teamGroups: {}, // no groups
    });
    const result = canWriteAtScope("agent-a", "team", config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not a member");
  });

  it("denies global scope when not configured", () => {
    const config = makeConfig();
    expect(canWriteAtScope("agent-a", "global", config).allowed).toBe(false);
  });

  it("allows global scope when configured", () => {
    const config = makeConfig({
      allowedScopes: { "agent-a": ["self", "team", "global"] },
    });
    expect(canWriteAtScope("agent-a", "global", config).allowed).toBe(true);
  });
});

describe("canReadRecord", () => {
  it("allows owner to read own record regardless of scope", () => {
    const config = makeConfig();
    const record = makeRecord({ scope: "self", agentId: "agent-a" });
    expect(canReadRecord("agent-a", record, config).allowed).toBe(true);
  });

  it("denies other agents from reading self-scoped records", () => {
    const config = makeConfig();
    const record = makeRecord({ scope: "self", agentId: "agent-a" });
    const result = canReadRecord("agent-b", record, config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("scope is 'self'");
  });

  it("allows team member to read team-scoped record", () => {
    const config = makeConfig({
      teamGroups: { devs: ["agent-a", "agent-b"] },
    });
    const record = makeRecord({ scope: "team", agentId: "agent-a" });
    expect(canReadRecord("agent-b", record, config).allowed).toBe(true);
  });

  it("denies non-team-member from reading team-scoped record", () => {
    const config = makeConfig({
      teamGroups: { devs: ["agent-a"] },
    });
    const record = makeRecord({ scope: "team", agentId: "agent-a" });
    const result = canReadRecord("agent-c", record, config);
    expect(result.allowed).toBe(false);
  });

  it("allows any agent to read global-scoped record", () => {
    const config = makeConfig();
    const record = makeRecord({ scope: "global", agentId: "agent-a" });
    expect(canReadRecord("agent-x", record, config).allowed).toBe(true);
  });

  it("respects ACL deny list", () => {
    const config = makeConfig();
    const record = makeRecord({
      scope: "global",
      agentId: "agent-a",
      acl: { deny: ["agent-blocked"] },
    });
    expect(canReadRecord("agent-blocked", record, config).allowed).toBe(false);
    expect(canReadRecord("agent-ok", record, config).allowed).toBe(true);
  });

  it("respects ACL allow list", () => {
    const config = makeConfig();
    const record = makeRecord({
      scope: "global",
      agentId: "agent-a",
      acl: { allow: ["agent-friend"] },
    });
    expect(canReadRecord("agent-friend", record, config).allowed).toBe(true);
    expect(canReadRecord("agent-stranger", record, config).allowed).toBe(false);
  });

  it("deny list overrides allow list", () => {
    const config = makeConfig();
    const record = makeRecord({
      scope: "global",
      agentId: "agent-a",
      acl: { allow: ["agent-x"], deny: ["agent-x"] },
    });
    expect(canReadRecord("agent-x", record, config).allowed).toBe(false);
  });

  it("supports group-based ACL entries", () => {
    const config = makeConfig({
      teamGroups: { admins: ["agent-admin"] },
    });
    const record = makeRecord({
      scope: "global",
      agentId: "agent-a",
      acl: { allow: ["admins"] },
    });
    expect(canReadRecord("agent-admin", record, config).allowed).toBe(true);
    expect(canReadRecord("agent-regular", record, config).allowed).toBe(false);
  });
});

describe("validateSchemaVersion", () => {
  it("accepts current schema version", () => {
    const record = makeRecord();
    expect(validateSchemaVersion(record).allowed).toBe(true);
  });

  it("rejects wrong schema version", () => {
    const record = makeRecord({ schemaVersion: 999 });
    const result = validateSchemaVersion(record);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("mismatch");
  });
});
