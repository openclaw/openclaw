import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { renderStorageFailureSummary } from "../agents/failover/assistant-request-failure-copy.js";
import { McpOAuthStoreCorruptionError } from "../agents/mcp-oauth-store-error.js";
import { WorktreeRemovalContentionError } from "../agents/worktrees/errors.js";
import { SqliteTranscriptMutationConflictError } from "../config/sessions/session-mutation-conflict-error.js";
import {
  SessionTranscriptWriterClaimReboundError,
  type TranscriptAppendRefusal,
} from "../config/sessions/session-transcript-writer-claim-error.js";
import { WorkerSessionAlreadyAttachedError } from "../gateway/worker-environments/session-attachment.js";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import {
  classifyGatewayStorageFailure,
  isSqliteNativeOpenFailure,
  withSqliteNativeOpen,
} from "../infra/sqlite-error-diagnostics.js";
import {
  SqliteCoordinatorError,
  OpenClawStateExternalOwnershipError,
  OpenClawStateOwnershipError,
  OpenClawStateOwnershipMetadataError,
} from "../infra/sqlite-lifecycle-errors.js";
import { SqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { receiveSqliteWorkerReply } from "../infra/sqlite-worker-broker-reply.js";
import type { Job } from "../infra/sqlite-worker-broker.types.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  isSqliteWorkerError,
  retainSqliteWorkerErrorCode,
  SqliteWorkerError,
  type SqliteWorkerReply,
} from "../infra/sqlite-worker-contract.js";
import {
  exchangeSqliteDatabaseAdmissions,
  withSqliteDatabaseAdmissionWait,
} from "../infra/sqlite-worker-database-admission-relay.js";
import { hasSqliteWorkerErrorCode } from "../infra/sqlite-worker-error.js";
import { SqliteWorkerSlotCustody } from "../infra/sqlite-worker-request-custody.js";
import {
  findStartupMaintenanceRequiredError,
  StartupMaintenanceRequiredError,
} from "../infra/startup-maintenance-required.js";
import { PluginBlobStoreError } from "../plugin-state/plugin-blob-store.types.js";
import { PluginStateStoreError } from "../plugin-state/plugin-state-store.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { SkillUploadRequestError } from "../skills/lifecycle/upload-store-error.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import { DATABASE_QUARANTINE_READ_CLEANUP_ERROR_NAME } from "./openclaw-quarantine-error.js";
import {
  findOpenClawStateDatabaseFailure,
  markOpenClawStateDatabaseFailure,
} from "./openclaw-state-db-failure.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import { toOpenClawStateLeaseVerificationError } from "./openclaw-state-lease-error.js";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
  type OpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

function remoteError(payload: OpenClawStateWorkerErrorPayload | undefined): Error {
  const retained = new Error("remote error");
  retainOpenClawStateWorkerErrorPayload(retained, payload);
  return retained;
}

function errorGroup(errors: unknown[], cause?: unknown) {
  return new AggregateError(errors, "aggregate", cause === undefined ? undefined : { cause });
}

function transport(
  error: Error,
  options: Parameters<typeof encodeOpenClawStateWorkerError>[1] = {},
) {
  const payload = encodeOpenClawStateWorkerError(error, options);
  assert(payload, "expected a canonical shared-state error payload");
  const retained = remoteError(structuredClone(payload));
  const decoded = hydrateOpenClawStateWorkerError(retained, options);
  expect(decoded).not.toBe(retained);
  return decoded;
}

function roundTrip(error: Error): Error {
  const decoded = transport(error);
  expect(decoded).toBeInstanceOf(error.constructor);
  expect(decoded).toMatchObject({ name: error.name, message: error.message });
  return decoded;
}

function brokerFailure(error: Extract<SqliteWorkerReply, { ok: false }>["error"]) {
  const custody = new SqliteWorkerSlotCustody().createRequest();
  custody.activate();
  custody.accept();
  const job: Job = {
    custody,
    observation: { started() {}, completed() {} },
    request: {
      type: "execute",
      id: 1,
      actor: 1,
      input: new Uint8Array(),
      stateContext: { environment: { OPENCLAW_STATE_DIR: "/fixture" } },
    },
    bytes: 0,
    result: createDeferredCore().promise,
    resolve() {},
    reject() {},
    detach() {},
  };
  let failure: unknown;
  receiveSqliteWorkerReply(
    {
      current: job,
      actors: new Set(),
      worker: {
        postMessage() {
          throw new Error("Unexpected native dispatch");
        },
      },
    },
    { id: 1, ok: false, error },
    {
      fail(reason) {
        throw reason;
      },
      finish(_job, result) {
        failure = result;
      },
      dispatch() {},
    },
  );
  return failure;
}

it("retains canonical uncertainty on an ordinary diagnostic wrapper", () => {
  const error = retainSqliteWorkerErrorCode(
    new Error("Synthetic wrapper"),
    new SqliteWorkerError("Synthetic outcome", "outcome-unknown"),
  );
  expect(isSqliteWorkerError(transport(error), "outcome-unknown")).toBe(true);
});

it("preserves pre-execution admission-relay unavailability through the broker reply", () => {
  const channel = new MessageChannel();
  let original: unknown;
  try {
    withSqliteDatabaseAdmissionWait({ deadlineAtMs: Date.now() - 1 }, () =>
      exchangeSqliteDatabaseAdmissions(channel.port1, []),
    );
  } catch (error) {
    original = error;
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
  assert(original instanceof Error);
  expect(isSqliteWorkerError(original, "unavailable")).toBe(true);
  const sharedState = encodeOpenClawStateWorkerError(original, { includeOrdinary: true });
  assert(sharedState);
  const failure = brokerFailure({
    name: original.name,
    message: original.message,
    code: "unavailable",
    sharedState: structuredClone(sharedState),
  });
  expect(isSqliteWorkerError(failure, "unavailable")).toBe(true);
  expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(false);
  const storageFailure = classifyGatewayStorageFailure(failure);
  expect(storageFailure).toBe("unavailable");
  expect(renderStorageFailureSummary(storageFailure)).toBeTruthy();
});

it.each([
  ["outcome-unknown", false],
  ["outcome-unknown", true],
  ["unavailable", false],
  ["unavailable", true],
] as const)(
  "retains %s marked directly on cleanup aggregates (ordinary: %s)",
  (code, includeOrdinary) => {
    const original = retainSqliteWorkerErrorCode(
      new AggregateError([], "Synthetic cleanup"),
      new SqliteWorkerError("Synthetic outcome", code),
    );
    const options = { includeOrdinary };
    const decoded = transport(original, options);
    expect(decoded).toBeInstanceOf(AggregateError);
    expect(hasSqliteWorkerOutcomeUnknown(decoded)).toBe(code === "outcome-unknown");
    expect(hasSqliteWorkerErrorCode(decoded, code)).toBe(true);
    expect(isSqliteWorkerError(decoded, code)).toBe(false);
  },
);

it.each([false, true])(
  "retains canonical unknown outcomes through worker graphs (nested: %s)",
  (nested) => {
    const primary = new SqliteWorkerError("Synthetic lost acknowledgment", "outcome-unknown");
    const error = nested
      ? errorGroup([primary, new Error("Synthetic cleanup failure")], primary)
      : primary;
    const decoded = roundTrip(error);
    expect(hasSqliteWorkerOutcomeUnknown(decoded)).toBe(true);
    expect(hasSqliteWorkerErrorCode(decoded, "outcome-unknown")).toBe(!nested);
    expect(isSqliteWorkerError(decoded, "outcome-unknown")).toBe(!nested);
    if (decoded instanceof AggregateError) {
      expect(decoded.cause).toBe(decoded.errors[0]);
      expect(isSqliteWorkerError(decoded.cause, "outcome-unknown")).toBe(true);
    }
  },
);

it.each([
  ["outcome-unknown", false],
  ["outcome-unknown", true],
  ["unavailable", false],
  ["unavailable", true],
] as const)(
  "does not promote ordinary worker error lookalikes into canonical %s (aggregate: %s)",
  (code, aggregate) => {
    const ordinary = Object.assign(
      aggregate
        ? new AggregateError([], "Synthetic provider failure")
        : new Error("Synthetic provider failure"),
      { name: "SqliteWorkerError", code },
    );
    const decoded = transport(ordinary, { includeOrdinary: true });
    expect(hasSqliteWorkerOutcomeUnknown(decoded)).toBe(false);
    expect(hasSqliteWorkerErrorCode(decoded, code)).toBe(false);
    expect(isSqliteWorkerError(decoded, code)).toBe(false);
  },
);

describe("shared-state worker error transport", () => {
  const syntaxCause = new SyntaxError("Synthetic malformed JSON");
  const owner = { pid: 42, threadId: 7, version: "fixture" };
  const path = "/fixture/state.sqlite";
  const verificationCause = new Error("Synthetic read failure");
  const identity = { scope: "test", key: "read", leaseLabel: "test lease" };
  const verification = toOpenClawStateLeaseVerificationError(identity, verificationCause);
  const transcriptRefusals = [
    {
      code: "session-entry-missing",
      agentIdHash: "sha256:0123456789ab",
      expectedSessionIdHash: "sha256:abcdef012345",
      sessionKeyHash: "-",
    },
    {
      code: "session-rebound",
      agentIdHash: "sha256:0123456789ab",
      expectedSessionIdHash: "sha256:abcdef012345",
      sessionKeyHash: "sha256:123456abcdef",
      actualSessionIdHash: "sha256:987654fedcba",
    },
  ] as const satisfies readonly TranscriptAppendRefusal[];
  const cases: Array<
    [error: Error, fields?: object, causeType?: new (message?: string) => Error, nativeOpen?: true]
  > = [
    [
      new PluginStateStoreError("plugin", {
        code: "PLUGIN_STATE_WRITE_FAILED",
        operation: "delete",
        path,
        owner,
        cause: syntaxCause,
      }),
      { code: "PLUGIN_STATE_WRITE_FAILED", operation: "delete", path, owner },
      SyntaxError,
    ],
    [
      new McpOAuthStoreCorruptionError("store", "invalid JSON", { cause: syntaxCause }),
      { cause: { name: "SyntaxError", message: syntaxCause.message } },
      Error,
    ],
    [
      new WorkerSessionAlreadyAttachedError("session", "environment"),
      { sessionId: "session", environmentId: "environment" },
    ],
    [new SqliteTranscriptMutationConflictError("session"), { sessionId: "session" }],
    ...transcriptRefusals.map((cause): [Error, object] => [
      new SessionTranscriptWriterClaimReboundError(cause),
      { cause },
    ]),
    ...["detail", new SyntaxError("rebound")].map(
      (cause): [Error, object, (new (message?: string) => Error)?] => [
        Object.assign(new SessionTranscriptWriterClaimReboundError(), { cause }),
        { cause: typeof cause === "string" ? cause : { message: cause.message } },
        cause instanceof Error ? SyntaxError : undefined,
      ],
    ),
    ...[undefined, "SQLITE_IOERR"].map((code): [Error, object, undefined, true] => [
      Object.assign(new Error("native open"), { code }),
      { code },
      undefined,
      true,
    ]),
    ...[
      { code: "ERR_SQLITE_ERROR", errcode: 517 },
      { code: "ERR_SQLITE_ERROR", errcode: 262 },
      { code: "ERR_SQLITE_ERROR", errcode: 26 },
      { code: "ERR_SQLITE_ERROR", errcode: 266 },
      { code: "SQLITE_BUSY" },
      { code: "SQLITE_LOCKED" },
    ].map((fields): [Error, object] => [Object.assign(new Error("SQLite"), fields), fields]),
    ...[RangeError, SyntaxError, TypeError, SkillUploadRequestError].map(
      (ErrorType): [Error, object] => [
        Object.assign(new ErrorType("invalid"), {
          code: "ERR_OUT_OF_RANGE",
          cause: new Error("decode"),
        }),
        { code: "ERR_OUT_OF_RANGE", cause: { message: "decode" } },
      ],
    ),
    [
      verification,
      {
        code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
        cause: { message: verificationCause.message },
      },
      Error,
    ],
    [new OpenClawStateOwnershipError("owner")],
    [new OpenClawStateOwnershipMetadataError(path, "metadata"), { databasePath: path }],
    [
      new OpenClawStateExternalOwnershipError(path, "manager"),
      { databasePath: path, managerId: "manager" },
    ],
    [
      new StartupMaintenanceRequiredError("state-migrations", "migration"),
      { kind: "state-migrations", reason: "migration" },
    ],
    [
      new SqliteSchemaVersionError("schema"),
      { kind: "newer-schema", reason: "a newer OpenClaw build" },
    ],
    ...(
      [
        ["audit-events-v2", "state database schema migration"],
        ["legacy-cron-run-logs", "cron run history migration"],
      ] as const
    ).map(([kind, reason]): [Error, object] => [
      new OpenClawStateDatabaseSchemaMigrationRequiredError(kind, path),
      { kind, pathname: path, reason },
    ]),
    [
      new OpenClawAgentDatabaseMediaMigrationRequiredError("/fixture/agent.sqlite", 11),
      {
        kind: "agent-media",
        pathname: "/fixture/agent.sqlite",
        schemaVersion: 11,
        reason: "offline media migration",
      },
    ],
    [
      new SqliteCoordinatorError("admission", new Error("native")),
      { cause: { message: "native" } },
      Error,
    ],
    [new GatewayStateOwnerContentionError(path), { databasePath: path }],
  ];
  it.for(cases)(
    "preserves %s identity and recovery fields: %s",
    ([error, fields, causeType, nativeOpen]) => {
      if (nativeOpen) {
        expect(() =>
          withSqliteNativeOpen(() => {
            throw error;
          }),
        ).toThrow(error);
      }
      if (error === verification) {
        expect(error.cause).toBe(verificationCause);
        expect(toOpenClawStateLeaseVerificationError(identity, error)).toBe(error);
      }
      const decoded = roundTrip(error);
      expect(decoded).not.toBe(error);
      if (fields && !nativeOpen) {
        expect(decoded).toMatchObject(fields);
      }
      if (causeType) {
        expect(decoded.cause).toBeInstanceOf(causeType);
      }
      if (nativeOpen) {
        expect("code" in decoded ? decoded.code : undefined).toBe(
          "code" in error ? error.code : undefined,
        );
        expect(isSqliteNativeOpenFailure(decoded)).toBe(true);
      }
      if (error instanceof StartupMaintenanceRequiredError) {
        expect(findStartupMaintenanceRequiredError(decoded)).toBe(decoded);
        expect(decoded).toMatchObject({ code: "gateway.maintenance_required" });
      }
      expect(hydrateOpenClawStateWorkerError(decoded)).toBe(decoded);
    },
  );

  it("retains Blob primary failure and shared references in cleanup aggregates", () => {
    const primary = new PluginBlobStoreError("Synthetic read failure", {
      code: "PLUGIN_BLOB_READ_FAILED",
      operation: "lookup",
      path: "/fixture/blob.sqlite",
      cause: Object.assign(new Error("Synthetic SQLite cause"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 1,
      }),
    });
    const cleanup = new Error("Synthetic cleanup failure");
    const combined = errorGroup([primary, cleanup, primary], primary);
    combined.errors.push(combined);
    const decoded = roundTrip(combined);
    assert(decoded instanceof AggregateError);
    expect(decoded.errors[0]).toBeInstanceOf(PluginBlobStoreError);
    expect(decoded.errors[0]).toMatchObject({
      code: "PLUGIN_BLOB_READ_FAILED",
      operation: "lookup",
      path: "/fixture/blob.sqlite",
      cause: { message: "Synthetic SQLite cause", code: "ERR_SQLITE_ERROR", errcode: 1 },
    });
    expect(decoded.errors[0]).toBe(decoded.errors[2]);
    expect(decoded.cause).toBe(decoded.errors[0]);
    expect(decoded.errors[1]).toMatchObject({ message: cleanup.message });
    expect(decoded.errors[3]).toBe(decoded);
  });

  it("uses the wire root when retaining an unopened error graph", () => {
    const retained = remoteError({
      version: 1,
      root: 1,
      nodes: [
        { type: "newer-schema", name: "SqliteSchemaVersionError", message: "newer" },
        { type: "aggregate", name: "AggregateError", message: "wrapper", errors: [{ ref: 0 }] },
      ],
    });
    const hydrated = hydrateOpenClawStateWorkerError(retained);
    expect(hydrated).toBeInstanceOf(AggregateError);
    expect(findStartupMaintenanceRequiredError(hydrated)).toBeInstanceOf(SqliteSchemaVersionError);
  });

  it.each([
    new SqliteSchemaVersionError("newer schema"),
    Object.assign(new Error("native lock contention"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
  ])("keeps outcome-unknown explicit instead of hydrating %s", (original) => {
    const payload = encodeOpenClawStateWorkerError(original);
    assert(payload);
    const failure = brokerFailure({
      name: "SqliteWorkerError",
      message: "write outcome unknown",
      code: "outcome-unknown",
      sharedState: payload,
    });
    assert(failure instanceof Error, "Expected the broker to settle the original failure");
    expect(hydrateOpenClawStateWorkerError(failure)).toBe(failure);
    expect(failure).toMatchObject({ code: "outcome-unknown" });
    expect(findStartupMaintenanceRequiredError(failure)).toBeUndefined();
  });

  it("hydrates a cached rejection independently for each caller without rewriting its graph", () => {
    const payload = encodeOpenClawStateWorkerError(new SqliteSchemaVersionError("newer schema"));
    assert(payload);
    const remote = remoteError(payload);
    expect(Object.keys(remote)).toEqual([]);
    expect(JSON.stringify(remote)).toBe("{}");
    const untouched = new Error("local cleanup");
    const original = errorGroup([remote, remote, untouched], remote);
    original.errors.push(original);
    const first = hydrateOpenClawStateWorkerError(original);
    const second = hydrateOpenClawStateWorkerError(original);
    assert(first instanceof AggregateError && second instanceof AggregateError);
    expect(first).not.toBe(second);
    expect(first.errors[0]).not.toBe(second.errors[0]);
    expect(first.errors[0]).toBeInstanceOf(StartupMaintenanceRequiredError);
    expect(second.errors[0]).toBeInstanceOf(StartupMaintenanceRequiredError);
    for (const result of [first, second]) {
      expect(result.cause).toBe(result.errors[0]);
      expect(result.errors[1]).toBe(result.errors[0]);
      expect(result.errors[2]).toBe(untouched);
    }
    expect(original.cause).toBe(remote);
    expect(original.errors).toEqual([remote, remote, untouched, original]);
  });

  it("leaves ordinary and already-current error graphs identical", () => {
    const local = new Error("caller rejected");
    const ordinary = errorGroup([local], local);
    local.cause = ordinary;
    expect(hydrateOpenClawStateWorkerError(ordinary)).toBe(ordinary);
    const current = roundTrip(new SqliteSchemaVersionError("current caller"));
    const wrapped = errorGroup([current], current);
    expect(hydrateOpenClawStateWorkerError(wrapped)).toBe(wrapped);
    expect(hydrateOpenClawStateWorkerError("caller rejection")).toBe("caller rejection");
  });

  it("preserves shared causes, cycles, and newer-schema precedence through aggregate wrappers", () => {
    const repair = new OpenClawStateDatabaseSchemaMigrationRequiredError(
      "audit-events-v2",
      "/fixture/state.sqlite",
    );
    const newer = new SqliteSchemaVersionError("a newer schema wins");
    const wrapper = Object.assign(new Error("operation failed", { cause: repair }), {
      code: "EWRAPPED",
    });
    const root = errorGroup([wrapper, repair, newer], wrapper);
    repair.cause = root;

    const decoded = roundTrip(root);
    assert(decoded instanceof AggregateError);
    expect(decoded.cause).toBe(decoded.errors[0]);
    const restoredWrapper: unknown = decoded.errors[0];
    const restoredRepair: unknown = decoded.errors[1];
    assert(restoredWrapper instanceof Error && restoredRepair instanceof Error);
    expect(restoredWrapper).toMatchObject({ code: "EWRAPPED" });
    expect(restoredWrapper.cause).toBe(restoredRepair);
    expect(restoredRepair.cause).toBe(decoded);
    expect(findStartupMaintenanceRequiredError(decoded)).toBe(decoded.errors[2]);
    expect(findStartupMaintenanceRequiredError(decoded)?.kind).toBe("newer-schema");
  });

  it("keeps scalar causes without reviving arbitrary classes or serializing object fields", () => {
    class CustomError extends Error {}
    const custom = Object.assign(new CustomError("custom wrapper", { cause: "detail" }), {
      name: "CustomError",
      code: 17,
      privateState: { token: "fixture-not-for-transport" },
    });
    const original = errorGroup([
      new OpenClawStateOwnershipError("canonical refusal"),
      custom,
      "plain failure",
      2,
      true,
      null,
      undefined,
      { token: "fixture-not-for-transport" },
    ]);
    const payload = encodeOpenClawStateWorkerError(original);
    expect(JSON.stringify(payload)).not.toContain("fixture-not-for-transport");
    expect(payload?.nodes.every((node) => !("stack" in node))).toBe(true);
    const decoded = roundTrip(original);
    assert(decoded instanceof AggregateError);
    expect(decoded.errors[1]).toBeInstanceOf(Error);
    expect(decoded.errors[1]).not.toBeInstanceOf(CustomError);
    expect(decoded.errors[1]).toMatchObject({ name: "CustomError", code: 17, cause: "detail" });
    expect(decoded.errors.slice(2)).toEqual(["plain failure", 2, true, null, undefined, undefined]);
  });

  it("projects typed ownership metadata before transporting it", () => {
    const pluginOwner = {
      pid: 123,
      threadId: 4,
      version: "test",
      privateState: "not-for-transport",
    };
    const blockedByRun = { worktreeId: "fixture", pid: 456, privateState: "not-for-transport" };
    const original = errorGroup([
      new PluginStateStoreError("fixture plugin error", {
        code: "PLUGIN_STATE_READ_FAILED",
        operation: "lookup",
        owner: pluginOwner,
      }),
      new WorktreeRemovalContentionError("busy", "fixture contention", blockedByRun),
    ]);
    expect(JSON.stringify(encodeOpenClawStateWorkerError(original))).not.toContain(
      "not-for-transport",
    );
    const restored = roundTrip(original);
    assert(restored instanceof AggregateError);
    expect(restored.errors[0]).toMatchObject({ owner: { pid: 123, threadId: 4, version: "test" } });
    expect(restored.errors[1]).toMatchObject({ blockedByRun: { worktreeId: "fixture", pid: 456 } });
  });

  it("transports only redacted refusal fields belonging to a transcript writer error", () => {
    const cause = { ...transcriptRefusals[1], privateState: "fixture-not-for-transport" };
    const primary = new SessionTranscriptWriterClaimReboundError(cause);
    const unredacted = Object.assign(new SessionTranscriptWriterClaimReboundError(), {
      cause: { ...cause, sessionKeyHash: "fixture-not-for-transport" },
    });
    const original = errorGroup([primary, new Error("ordinary wrapper", { cause }), unredacted]);
    const payload = encodeOpenClawStateWorkerError(original);
    expect(JSON.stringify(payload)).not.toContain("fixture-not-for-transport");
    const decoded = roundTrip(original);
    assert(decoded instanceof AggregateError);
    expect(decoded.errors[0]).toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
    expect(decoded.errors[0].cause).toEqual(transcriptRefusals[1]);
    expect(decoded.errors[1].cause).toBeUndefined();
    expect(decoded.errors[2].cause).toBeUndefined();
  });

  it("leaves unrelated errors and name-only imitations on the ordinary transport", () => {
    const imitation = Object.assign(new Error("imitation"), { name: "SqliteSchemaVersionError" });
    for (const error of [
      new Error("ordinary"),
      Object.assign(new Error("range imitation"), { name: "RangeError", code: "ERR_OUT_OF_RANGE" }),
      Object.assign(new Error("syntax imitation"), { name: "SyntaxError" }),
      Object.assign(new Error("type imitation"), { name: "TypeError" }),
      Object.assign(new Error("upload imitation"), { name: "SkillUploadRequestError" }),
      Object.assign(new Error("native open imitation"), { nativeOpen: true, code: "SQLITE_IOERR" }),
      Object.assign(new Error("terminal admission imitation"), {
        name: "SqliteIntegrityError",
        stateDatabasePath: "/isolated/state.sqlite",
      }),
      imitation,
      new AggregateError([imitation], "ordinary aggregate"),
      Object.assign(new Error("cleanup imitation"), {
        name: DATABASE_QUARANTINE_READ_CLEANUP_ERROR_NAME,
      }),
      Object.assign(new AggregateError([], "cleanup aggregate imitation"), {
        name: DATABASE_QUARANTINE_READ_CLEANUP_ERROR_NAME,
      }),
      { cause: new OpenClawStateOwnershipError("nested object") },
    ]) {
      expect(encodeOpenClawStateWorkerError(error)).toBeUndefined();
    }
  });

  it("preserves the canonical state refusal path and native cause through cleanup aggregates", () => {
    const native = Object.assign(new Error("database corruption"), { errcode: 11 });
    const failure = Object.assign(new Error("integrity admission refused", { cause: native }), {
      name: "SqliteIntegrityError",
    });
    markOpenClawStateDatabaseFailure(failure, "/isolated/state.sqlite");
    const original = errorGroup([failure, new Error("cleanup failed")], failure);
    const decoded = roundTrip(original);
    expect(findOpenClawStateDatabaseFailure(decoded, "/isolated/other.sqlite")).toBeUndefined();
    expect(findOpenClawStateDatabaseFailure(decoded, "/isolated/state.sqlite")).toMatchObject({
      name: "SqliteIntegrityError",
      cause: { errcode: 11 },
    });
    expect(findOpenClawStateDatabaseFailure(decoded, "/isolated/state.sqlite")).toBe(decoded.cause);
  });

  it("opts into complete ordinary graphs without promoting name-only classifications", () => {
    const native = Object.assign(new Error("ordinary read failed"), {
      code: "EIO",
      errno: -5,
      privateState: "fixture-not-for-transport",
    });
    const integrity = Object.assign(new Error("read refused", { cause: native }), {
      name: "SqliteIntegrityError",
    });
    const imitation = Object.assign(new Error("name only"), { name: "SqliteSchemaVersionError" });
    const original = errorGroup([integrity, native, imitation], integrity);
    original.errors.push(original);
    const options = { includeOrdinary: true };
    expect(encodeOpenClawStateWorkerError(original)).toBeUndefined();
    const payload = encodeOpenClawStateWorkerError(original, options);
    expect(payload).toBeDefined();
    expect(JSON.stringify(payload)).not.toContain("fixture-not-for-transport");
    const retained = remoteError(structuredClone(payload));
    expect(hydrateOpenClawStateWorkerError(retained)).toBe(retained);

    const decoded = hydrateOpenClawStateWorkerError(retained, options);
    assert(decoded instanceof AggregateError);
    expect(decoded.cause).toBe(decoded.errors[0]);
    expect(decoded.errors[0]).toMatchObject({ name: "SqliteIntegrityError" });
    expect(decoded.errors[0].cause).toBe(decoded.errors[1]);
    expect(decoded.errors[1]).toMatchObject({ code: "EIO", errno: -5 });
    expect(decoded.errors[2]).not.toBeInstanceOf(SqliteSchemaVersionError);
    expect(decoded.errors[3]).toBe(decoded);
    expect(findStartupMaintenanceRequiredError(decoded)).toBeUndefined();
    expect(hydrateOpenClawStateWorkerError(retained, options)).not.toBe(decoded);
  });

  it("does not admit a cleanup name on a non-aggregate wire node", () => {
    const retained = remoteError({
      version: 1,
      root: 0,
      nodes: [
        { type: "error", name: DATABASE_QUARANTINE_READ_CLEANUP_ERROR_NAME, message: "imitation" },
      ],
    });
    expect(hydrateOpenClawStateWorkerError(retained)).toBe(retained);
  });
});
