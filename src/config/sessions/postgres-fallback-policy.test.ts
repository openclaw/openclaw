import { describe, expect, it } from "vitest";
import { evaluateSessionStoreJsonFallback } from "./postgres-fallback-policy.js";

describe("postgres session-store JSON fallback policy", () => {
  it("treats json-primary as the only implicit JSON path", () => {
    expect(
      evaluateSessionStoreJsonFallback({
        phase: "json-primary",
        operation: "read",
      }),
    ).toEqual({
      allowed: true,
      action: "use-json-primary",
      denials: [],
    });
  });

  it("allows shadow read fallback only before committed Postgres state exists", () => {
    expect(
      evaluateSessionStoreJsonFallback({
        phase: "postgres-shadow",
        operation: "read",
      }),
    ).toEqual({
      allowed: true,
      action: "allow-shadow-read-fallback",
      denials: [],
    });

    expect(
      evaluateSessionStoreJsonFallback({
        phase: "postgres-shadow",
        operation: "read",
        postgresWriteSucceeded: true,
        postgresMigrationApplied: true,
      }),
    ).toMatchObject({
      allowed: false,
      action: "deny",
      denials: [
        expect.objectContaining({ code: "postgres_write_committed" }),
        expect.objectContaining({ code: "postgres_migration_applied" }),
      ],
    });
  });

  it("denies shadow write fallback because it can create split-brain state", () => {
    expect(
      evaluateSessionStoreJsonFallback({
        phase: "postgres-shadow",
        operation: "transcript-write",
      }),
    ).toMatchObject({
      allowed: false,
      action: "deny",
      denials: [expect.objectContaining({ code: "write_fallback_forbidden" })],
    });
  });

  it("denies postgres-primary JSON fallback even when rollback evidence is partially present", () => {
    expect(
      evaluateSessionStoreJsonFallback({
        phase: "postgres-primary",
        operation: "read",
        postgresWriteSucceeded: true,
        jsonEvidencePreserved: true,
        explicitRollbackRequested: true,
        rollbackReceiptRecorded: true,
      }),
    ).toMatchObject({
      allowed: false,
      action: "deny",
      denials: [
        expect.objectContaining({ code: "postgres_primary_fallback_forbidden" }),
        expect.objectContaining({ code: "postgres_write_committed" }),
      ],
    });
  });

  it("allows rollback-to-json only with explicit rollback receipt and preserved JSON evidence", () => {
    expect(
      evaluateSessionStoreJsonFallback({
        phase: "rollback-to-json",
        operation: "batch-write",
        jsonEvidencePreserved: true,
        explicitRollbackRequested: true,
        rollbackReceiptRecorded: true,
      }),
    ).toEqual({
      allowed: true,
      action: "allow-explicit-rollback-to-json",
      denials: [],
    });

    expect(
      evaluateSessionStoreJsonFallback({
        phase: "rollback-to-json",
        operation: "read",
      }),
    ).toMatchObject({
      allowed: false,
      action: "deny",
      denials: [
        expect.objectContaining({ code: "rollback_not_explicit" }),
        expect.objectContaining({ code: "rollback_receipt_missing" }),
        expect.objectContaining({ code: "json_evidence_not_preserved" }),
      ],
    });
  });
});
