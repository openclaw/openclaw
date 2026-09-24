import { describe, expect, it, vi } from "vitest";
import { McpOAuthStoreCorruptionError } from "../agents/mcp-oauth-store-error.js";
import { WorkerSessionAlreadyAttachedError } from "../gateway/worker-environments/session-attachment.js";
import { SqliteCoordinatorError } from "../infra/sqlite-coordinator.js";
import {
  isSqliteNativeOpenFailure,
  withSqliteNativeOpen,
} from "../infra/sqlite-error-diagnostics.js";
import { SqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { receiveSqliteWorkerReply } from "../infra/sqlite-worker-broker-reply.js";
import type { Job } from "../infra/sqlite-worker-broker.types.js";
import {
  findStartupMaintenanceRequiredError,
  StartupMaintenanceRequiredError,
} from "../infra/startup-maintenance-required.js";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator.js";
import { PluginBlobStoreError } from "../plugin-state/plugin-blob-store.types.js";
import { SkillUploadRequestError } from "../skills/lifecycle/upload-store-error.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import { DATABASE_QUARANTINE_READ_CLEANUP_ERROR_NAME } from "./openclaw-quarantine-error.js";
import {
  findOpenClawStateDatabaseFailure,
  markOpenClawStateDatabaseFailure,
} from "./openclaw-state-db-failure.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import {
  OpenClawStateLeaseError,
  toOpenClawStateLeaseVerificationError,
} from "./openclaw-state-lease-error.js";
import {
  OpenClawStateExternalOwnershipError,
  OpenClawStateOwnershipError,
  OpenClawStateOwnershipMetadataError,
} from "./openclaw-state-ownership.js";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

function roundTrip(error: Error): Error {
  const payload = encodeOpenClawStateWorkerError(error);
  if (!payload) {
    throw new Error("expected a canonical shared-state error payload");
  }
  const retained = new Error("remote error");
  retainOpenClawStateWorkerErrorPayload(retained, structuredClone(payload));
  const decoded = hydrateOpenClawStateWorkerError(retained);
  if (decoded === retained) {
    throw new Error("expected a decoded shared-state error");
  }
  return decoded;
}

describe("shared-state worker error transport", () => {
  it("preserves MCP OAuth corruption details and parsing cause", () => {
    const cause = new SyntaxError("Synthetic malformed JSON");
    const error = new McpOAuthStoreCorruptionError(
      "synthetic-store",
      "store_json is not valid JSON",
      {
        cause,
      },
    );
    const decoded = roundTrip(error);
    expect(decoded).toBeInstanceOf(McpOAuthStoreCorruptionError);
    expect(decoded).toMatchObject({ name: error.name, message: error.message });
    expect(decoded.cause).toBeInstanceOf(Error);
    expect(decoded.cause).toMatchObject({ name: "SyntaxError", message: cause.message });
  });

  it("preserves the attachment conflict identity used for credential recovery", () => {
    const original = new WorkerSessionAlreadyAttachedError("session", "environment");
    const decoded = roundTrip(original);
    expect(decoded).toBeInstanceOf(WorkerSessionAlreadyAttachedError);
    expect(decoded).toMatchObject({
      message: original.message,
      sessionId: "session",
      environmentId: "environment",
    });
  });

  it.each([undefined, "SQLITE_IOERR"])(
    "preserves native-open provenance before lease dispatch (code: %s)",
    (code) => {
      const original = Object.assign(new Error("native open refused"), { code });
      expect(() =>
        withSqliteNativeOpen(() => {
          throw original;
        }),
      ).toThrow(original);

      const decoded = roundTrip(original);
      expect(decoded).not.toBe(original);
      expect(decoded).toMatchObject({ message: original.message });
      expect("code" in decoded ? decoded.code : undefined).toBe(code);
      expect(isSqliteNativeOpenFailure(decoded)).toBe(true);
      expect(hydrateOpenClawStateWorkerError(decoded)).toBe(decoded);
    },
  );

  it.each(
    [RangeError, SyntaxError, TypeError, SkillUploadRequestError].flatMap((ErrorType) =>
      [false, true].map((aggregate) => ({ ErrorType, name: ErrorType.name, aggregate })),
    ),
  )("preserves $name identity with aggregate=$aggregate", ({ ErrorType, aggregate }) => {
    const original = Object.assign(new ErrorType("Synthetic invalid request"), {
      code: "ERR_OUT_OF_RANGE",
      cause: new Error("Synthetic decoding cause"),
    });
    const root = aggregate
      ? new AggregateError([original, original], "Read and cleanup", { cause: original })
      : original;
    const decoded = roundTrip(root);
    const restored = aggregate ? decoded.cause : decoded;
    expect(restored).toBeInstanceOf(ErrorType);
    expect(restored).toMatchObject({
      name: original.name,
      message: original.message,
      code: original.code,
      cause: { message: "Synthetic decoding cause" },
    });
    if (aggregate) {
      expect(decoded).toBeInstanceOf(AggregateError);
      if (!(decoded instanceof AggregateError)) {
        throw new Error("Expected aggregate read failure");
      }
      expect(decoded.errors).toHaveLength(2);
      expect(decoded.errors[0]).toBe(restored);
      expect(decoded.errors[1]).toBe(restored);
    }
    expect(hydrateOpenClawStateWorkerError(decoded)).toBe(decoded);
  });

  it.each([
    ["PLUGIN_BLOB_OPEN_FAILED", "open"],
    ["PLUGIN_BLOB_WRITE_FAILED", "register"],
    ["PLUGIN_BLOB_READ_FAILED", "lookup"],
    ["PLUGIN_BLOB_CORRUPT", "entries"],
    ["PLUGIN_BLOB_LIMIT_EXCEEDED", "register"],
    ["PLUGIN_BLOB_INVALID_INPUT", "sweep"],
  ] as const)("preserves Blob error identity for %s", (code, operation) => {
    const error = new PluginBlobStoreError("Synthetic blob refusal", {
      code,
      operation,
      path: "/fixture/blob.sqlite",
      cause: Object.assign(new Error("Synthetic SQLite cause"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 1,
      }),
    });
    const decoded = roundTrip(error);
    expect(decoded).toBeInstanceOf(PluginBlobStoreError);
    expect(decoded).toMatchObject({
      code,
      operation,
      path: "/fixture/blob.sqlite",
      cause: { message: "Synthetic SQLite cause", code: "ERR_SQLITE_ERROR", errcode: 1 },
    });
  });

  it("retains Blob primary failure and shared references in cleanup aggregates", () => {
    const primary = new PluginBlobStoreError("Synthetic read failure", {
      code: "PLUGIN_BLOB_READ_FAILED",
      operation: "lookup",
      path: "/fixture/blob.sqlite",
    });
    const cleanup = new Error("Synthetic cleanup failure");
    const combined = new AggregateError([primary, cleanup, primary], "read and cleanup", {
      cause: primary,
    });
    combined.errors.push(combined);
    const decoded = roundTrip(combined);
    expect(decoded).toBeInstanceOf(AggregateError);
    if (!(decoded instanceof AggregateError)) {
      throw new Error("Expected aggregate");
    }
    expect(decoded.errors[0]).toBeInstanceOf(PluginBlobStoreError);
    expect(decoded.errors[0]).toBe(decoded.errors[2]);
    expect(decoded.cause).toBe(decoded.errors[0]);
    expect(decoded.errors[1]).toMatchObject({ message: cleanup.message });
    expect(decoded.errors[3]).toBe(decoded);
  });

  it.each([
    "OPENCLAW_STATE_LEASE_INVALID_INPUT",
    "OPENCLAW_STATE_LEASE_HELD",
    "OPENCLAW_STATE_LEASE_ABORTED",
    "OPENCLAW_STATE_LEASE_LOST",
    "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
  ] as const)("preserves lease classification and cause for %s", (code) => {
    const error = new OpenClawStateLeaseError("Synthetic lease refusal", {
      code,
      cause: new Error("Synthetic verification cause"),
    });
    const decoded = roundTrip(error);
    expect(decoded).toBeInstanceOf(OpenClawStateLeaseError);
    expect(decoded).toMatchObject({ name: error.name, message: error.message, code });
    expect(decoded.cause).toBeInstanceOf(Error);
    expect(decoded.cause).toMatchObject({ message: "Synthetic verification cause" });
  });
  it("preserves canonical verification wrapping through worker transport", () => {
    const cause = new Error("Synthetic read failure");
    const identity = { scope: "test", key: "read", leaseLabel: "test lease" };
    const wrapped = toOpenClawStateLeaseVerificationError(identity, cause);
    expect(wrapped.cause).toBe(cause);
    expect(toOpenClawStateLeaseVerificationError(identity, wrapped)).toBe(wrapped);
    const decoded = roundTrip(wrapped);
    expect(decoded).toBeInstanceOf(OpenClawStateLeaseError);
    expect(decoded).toMatchObject({
      code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
      message: "failed to verify test lease test/read",
      cause: { message: cause.message },
    });
  });

  it("uses the validated wire root when retaining an unopened error graph", () => {
    const retained = new Error("remote aggregate");
    retainOpenClawStateWorkerErrorPayload(retained, {
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

  it("keeps outcome-unknown explicit instead of hydrating a maintenance payload", () => {
    const payload = encodeOpenClawStateWorkerError(new SqliteSchemaVersionError("newer schema"));
    if (!payload) {
      throw new Error("Expected canonical payload");
    }
    const job: Job = {
      request: {
        type: "execute",
        id: 1,
        actor: 1,
        input: new Uint8Array(),
        stateContext: {
          environment: { OPENCLAW_STATE_DIR: "/fixture" },
          coordinatorRuntime: { directory: "/fixture/coordinator", keepAlive: false },
        },
      },
      bytes: 0,
      resolve: () => undefined,
      reject: () => undefined,
      detach: () => undefined,
    };
    let failure: unknown;
    receiveSqliteWorkerReply(
      {
        current: job,
        worker: {
          postMessage: () => {
            throw new Error("Unexpected native dispatch");
          },
        },
      },
      {
        id: 1,
        ok: false,
        error: {
          name: "SqliteWorkerError",
          message: "write outcome unknown",
          code: "outcome-unknown",
          sharedState: payload,
        },
      },
      {
        fail(error) {
          throw error;
        },
        finish(_job, error) {
          failure = error;
        },
        dispatch() {},
      },
    );
    if (!(failure instanceof Error)) {
      throw new Error("Expected the broker to settle the original failure");
    }
    expect(hydrateOpenClawStateWorkerError(failure)).toBe(failure);
    expect(failure).toMatchObject({ code: "outcome-unknown" });
    expect(findStartupMaintenanceRequiredError(failure)).toBeUndefined();
  });

  it("hydrates a cached rejection independently for each caller without rewriting its graph", async () => {
    const payload = encodeOpenClawStateWorkerError(new SqliteSchemaVersionError("newer schema"));
    if (!payload) {
      throw new Error("Expected canonical payload");
    }
    const remote = new Error("remote failure");
    retainOpenClawStateWorkerErrorPayload(remote, payload);
    expect(Object.keys(remote)).toEqual([]);
    expect(JSON.stringify(remote)).toBe("{}");
    const untouched = new Error("local cleanup");
    const original = new AggregateError([remote, remote, untouched], "open and cleanup failed", {
      cause: remote,
    });
    original.errors.push(original);
    const first = hydrateOpenClawStateWorkerError(original);
    vi.resetModules();
    const [codec, errors] = await Promise.all([
      import("./openclaw-state-worker-error.js"),
      import("../infra/startup-maintenance-required.js"),
    ]);
    const second = codec.hydrateOpenClawStateWorkerError(original);
    if (!(first instanceof AggregateError) || !(second instanceof AggregateError)) {
      throw new Error("Expected hydrated aggregate wrappers");
    }
    expect(first).not.toBe(second);
    expect(first.errors[0]).not.toBe(second.errors[0]);
    expect(first.errors[0]).toBeInstanceOf(StartupMaintenanceRequiredError);
    expect(second.errors[0]).toBeInstanceOf(errors.StartupMaintenanceRequiredError);
    for (const result of [first, second]) {
      expect(result.cause).toBe(result.errors[0]);
      expect(result.errors[1]).toBe(result.errors[0]);
      expect(result.errors[2]).toBe(untouched);
      expect(result.errors[3]).toBe(result);
    }
    expect(original.cause).toBe(remote);
    expect(original.errors).toEqual([remote, remote, untouched, original]);
  });

  it("retains aliases inside materialized wire graphs without merging distinct caller graphs", async () => {
    const refusal = new SqliteSchemaVersionError("newer schema");
    const original = new AggregateError([refusal, refusal], "wire graph", { cause: refusal });
    refusal.cause = original;
    const payload = encodeOpenClawStateWorkerError(original);
    if (!payload) {
      throw new Error("Expected canonical wire graph");
    }
    const retained = new Error("remote error");
    retainOpenClawStateWorkerErrorPayload(retained, payload);
    const first = hydrateOpenClawStateWorkerError(retained);
    const second = hydrateOpenClawStateWorkerError(retained);
    const combined = new AggregateError([first, second], "separate calls");
    vi.resetModules();
    const [codec, errors] = await Promise.all([
      import("./openclaw-state-worker-error.js"),
      import("../infra/startup-maintenance-required.js"),
    ]);
    const result = codec.hydrateOpenClawStateWorkerError(combined);
    if (!(result instanceof AggregateError)) {
      throw new Error("Expected aggregate wrapper");
    }
    expect(result.errors[0]).not.toBe(result.errors[1]);
    for (const graph of result.errors) {
      if (!(graph instanceof AggregateError)) {
        throw new Error("Expected materialized wire graph");
      }
      expect(graph.cause).toBe(graph.errors[0]);
      expect(graph.errors[0]).toBe(graph.errors[1]);
      expect(graph.errors[0]).toBeInstanceOf(errors.StartupMaintenanceRequiredError);
      const cause: unknown = graph.errors[0];
      if (!(cause instanceof Error)) {
        throw new Error("Expected hydrated cause");
      }
      expect(cause.cause).toBe(graph);
    }
    expect(combined.errors).toEqual([first, second]);
  });

  it("encodes and hydrates ordinary error graphs only with an explicit opt-in", () => {
    const cause = Object.assign(new Error("native failure"), { code: "SQLITE_BUSY" });
    const original = new AggregateError([cause], "load and cleanup", { cause });
    cause.cause = original;
    expect(encodeOpenClawStateWorkerError(original)).toBeUndefined();
    const payload = encodeOpenClawStateWorkerError(original, { includeOrdinary: true });
    expect(payload).toBeDefined();
    const retained = new Error("remote failure");
    retainOpenClawStateWorkerErrorPayload(retained, structuredClone(payload));
    expect(hydrateOpenClawStateWorkerError(retained)).toBe(retained);
    const decoded = hydrateOpenClawStateWorkerError(retained, { includeOrdinary: true });
    expect(decoded).toBeInstanceOf(AggregateError);
    expect(decoded.cause).toMatchObject({ message: "native failure", code: "SQLITE_BUSY" });
    if (!(decoded instanceof AggregateError) || !(decoded.cause instanceof Error)) {
      throw new Error("Expected the constructed aggregate and its cause");
    }
    expect(decoded.errors[0]).toBe(decoded.cause);
    expect(decoded.cause.cause).toBe(decoded);
  });

  it("leaves ordinary and already-current error graphs identical", () => {
    const local = new Error("caller rejected");
    const ordinary = new AggregateError([local], "caller and cleanup", { cause: local });
    local.cause = ordinary;
    expect(hydrateOpenClawStateWorkerError(ordinary)).toBe(ordinary);
    const current = roundTrip(new SqliteSchemaVersionError("current caller"));
    const wrapped = new AggregateError([current], "current graph", { cause: current });
    expect(hydrateOpenClawStateWorkerError(wrapped)).toBe(wrapped);
    expect(hydrateOpenClawStateWorkerError("caller rejection")).toBe("caller rejection");
  });

  it.each([
    {
      error: new OpenClawStateOwnershipError("owner refused"),
      constructor: OpenClawStateOwnershipError,
      fields: {},
    },
    {
      error: new OpenClawStateOwnershipMetadataError("/fixture/state.sqlite", "invalid metadata"),
      constructor: OpenClawStateOwnershipMetadataError,
      fields: { databasePath: "/fixture/state.sqlite" },
    },
    {
      error: new OpenClawStateExternalOwnershipError("/fixture/state.sqlite", "fixture-manager"),
      constructor: OpenClawStateExternalOwnershipError,
      fields: { databasePath: "/fixture/state.sqlite", managerId: "fixture-manager" },
    },
  ])("preserves ownership classification for $error.name", ({ error, constructor, fields }) => {
    const decoded = roundTrip(error);
    expect(decoded).toBeInstanceOf(constructor);
    expect(decoded).toBeInstanceOf(OpenClawStateOwnershipError);
    expect(decoded).toMatchObject({ ...fields, name: error.name, message: error.message });
  });

  it.each([
    {
      error: new StartupMaintenanceRequiredError("legacy-session-store", "session migration"),
      constructor: StartupMaintenanceRequiredError,
      fields: { kind: "legacy-session-store", reason: "session store migration" },
    },
    {
      error: new SqliteSchemaVersionError("newer schema"),
      constructor: SqliteSchemaVersionError,
      fields: { kind: "newer-schema", reason: "a newer OpenClaw build" },
    },
    {
      error: new OpenClawStateDatabaseSchemaMigrationRequiredError(
        "audit-events-v2",
        "/fixture/state.sqlite",
      ),
      constructor: OpenClawStateDatabaseSchemaMigrationRequiredError,
      fields: {
        kind: "audit-events-v2",
        pathname: "/fixture/state.sqlite",
        reason: "state database schema migration",
      },
    },
    {
      error: new OpenClawStateDatabaseSchemaMigrationRequiredError(
        "legacy-cron-run-logs",
        "/fixture/state.sqlite",
      ),
      constructor: OpenClawStateDatabaseSchemaMigrationRequiredError,
      fields: {
        kind: "legacy-cron-run-logs",
        pathname: "/fixture/state.sqlite",
        reason: "cron run history migration",
      },
    },
    {
      error: new OpenClawAgentDatabaseMediaMigrationRequiredError("/fixture/agent.sqlite", 11),
      constructor: OpenClawAgentDatabaseMediaMigrationRequiredError,
      fields: {
        kind: "agent-media",
        pathname: "/fixture/agent.sqlite",
        schemaVersion: 11,
        reason: "offline media migration",
      },
    },
  ])("preserves maintenance classification for $error.name", ({ error, constructor, fields }) => {
    const decoded = roundTrip(error);
    expect(decoded).toBeInstanceOf(constructor);
    expect(findStartupMaintenanceRequiredError(decoded)).toBe(decoded);
    expect(decoded).toMatchObject({
      ...fields,
      code: "gateway.maintenance_required",
      name: error.name,
      message: error.message,
    });
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
    const root = new AggregateError([wrapper, repair, newer], "operation and cleanup failed", {
      cause: wrapper,
    });
    repair.cause = root;

    const decoded = roundTrip(root);
    expect(decoded).toBeInstanceOf(AggregateError);
    if (!(decoded instanceof AggregateError)) {
      throw new Error("expected aggregate wrapper");
    }
    expect(decoded.cause).toBe(decoded.errors[0]);
    const restoredWrapper: unknown = decoded.errors[0];
    const restoredRepair: unknown = decoded.errors[1];
    if (!(restoredWrapper instanceof Error) || !(restoredRepair instanceof Error)) {
      throw new Error("expected restored error causes");
    }
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
    const original = new AggregateError(
      [
        new OpenClawStateOwnershipError("canonical refusal"),
        custom,
        "plain failure",
        2,
        true,
        null,
        undefined,
        { token: "fixture-not-for-transport" },
      ],
      "multiple errors",
    );
    const payload = encodeOpenClawStateWorkerError(original);
    expect(JSON.stringify(payload)).not.toContain("fixture-not-for-transport");
    expect(payload?.nodes.every((node) => !("stack" in node))).toBe(true);
    const decoded = roundTrip(original);
    if (!(decoded instanceof AggregateError)) {
      throw new Error("expected aggregate wrapper");
    }
    expect(decoded.errors[1]).toBeInstanceOf(Error);
    expect(decoded.errors[1]).not.toBeInstanceOf(CustomError);
    expect(decoded.errors[1]).toMatchObject({ name: "CustomError", code: 17, cause: "detail" });
    expect(decoded.errors.slice(2)).toEqual(["plain failure", 2, true, null, undefined, undefined]);
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
    const original = new AggregateError([failure, new Error("cleanup failed")], "open failed", {
      cause: failure,
    });
    const decoded = roundTrip(original);
    expect(findOpenClawStateDatabaseFailure(decoded, "/isolated/other.sqlite")).toBeUndefined();
    expect(findOpenClawStateDatabaseFailure(decoded, "/isolated/state.sqlite")).toMatchObject({
      name: "SqliteIntegrityError",
      cause: { errcode: 11 },
    });
    expect(findOpenClawStateDatabaseFailure(decoded, "/isolated/state.sqlite")).toBe(decoded.cause);
  });

  it("opts into complete ordinary graphs without promoting name-only classifications", () => {
    const native = Object.assign(new Error("native read failed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 11,
      privateState: "fixture-not-for-transport",
    });
    const integrity = Object.assign(new Error("read refused", { cause: native }), {
      name: "SqliteIntegrityError",
    });
    const imitation = Object.assign(new Error("name only"), { name: "SqliteSchemaVersionError" });
    const original = new AggregateError([integrity, native, imitation], "read and cleanup", {
      cause: integrity,
    });
    original.errors.push(original);
    const options = { includeOrdinary: true };
    const payload = encodeOpenClawStateWorkerError(original, options);
    expect(payload).toBeDefined();
    expect(JSON.stringify(payload)).not.toContain("fixture-not-for-transport");
    const retained = new Error("remote error");
    retainOpenClawStateWorkerErrorPayload(retained, structuredClone(payload));
    expect(hydrateOpenClawStateWorkerError(retained)).toBe(retained);

    const decoded = hydrateOpenClawStateWorkerError(retained, options);
    if (!(decoded instanceof AggregateError)) {
      throw new Error("expected ordinary aggregate graph");
    }
    expect(decoded.cause).toBe(decoded.errors[0]);
    expect(decoded.errors[0]).toMatchObject({ name: "SqliteIntegrityError" });
    expect(decoded.errors[0].cause).toBe(decoded.errors[1]);
    expect(decoded.errors[1]).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 11 });
    expect(decoded.errors[2]).not.toBeInstanceOf(SqliteSchemaVersionError);
    expect(decoded.errors[3]).toBe(decoded);
    expect(findStartupMaintenanceRequiredError(decoded)).toBeUndefined();
    expect(hydrateOpenClawStateWorkerError(retained, options)).not.toBe(decoded);
  });

  it("does not admit a cleanup name on a non-aggregate wire node", () => {
    const retained = new Error("ordinary transport failure");
    retainOpenClawStateWorkerErrorPayload(retained, {
      version: 1,
      root: 0,
      nodes: [
        { type: "error", name: DATABASE_QUARANTINE_READ_CLEANUP_ERROR_NAME, message: "imitation" },
      ],
    });
    expect(hydrateOpenClawStateWorkerError(retained)).toBe(retained);
  });

  it.each([
    new SqliteCoordinatorError("admission refused", new Error("native cause")),
    ...(["gateway-lifecycle", "state-lifecycle", "state-handles"] as const).map(
      (family) => new StateDatabaseCoordinatorContentionError(family),
    ),
  ])("preserves coordinator classification for %s", (original) => {
    const decoded = roundTrip(original);
    expect(decoded).toBeInstanceOf(SqliteCoordinatorError);
    expect(decoded).toMatchObject({ name: original.name, message: original.message });
    if (original instanceof StateDatabaseCoordinatorContentionError) {
      expect(decoded).toBeInstanceOf(StateDatabaseCoordinatorContentionError);
      expect(decoded).toMatchObject({ family: original.family });
    } else {
      expect(decoded.cause).toBeInstanceOf(Error);
      expect(decoded.cause).toMatchObject({ message: "native cause" });
    }
  });

  const validNode = {
    type: "maintenance",
    kind: "audit-events-v2",
    name: "StartupMaintenanceRequiredError",
    message: "migration required",
  };
  it.each([
    undefined,
    { version: 2, root: 0, nodes: [validNode] },
    { version: 1, root: 1, nodes: [validNode] },
    { version: 1, root: 0, nodes: [] },
    { version: 1, root: 0, nodes: [{ ...validNode, type: "CustomError" }] },
    { version: 1, root: 0, nodes: [{ ...validNode, kind: "unknown-migration" }] },
    { version: 1, root: 0, nodes: [{ ...validNode, cause: { ref: 1 } }] },
    { version: 1, root: 0, nodes: [{ ...validNode, cause: { value: {} } }] },
    { version: 1, root: 0, nodes: [{ ...validNode, code: {} }] },
    { version: 1, root: 0, nodes: [{ ...validNode, nativeOpen: false }] },
    { version: 1, root: 0, nodes: [{ ...validNode, errcode: -1 }] },
    { version: 1, root: 0, nodes: [{ ...validNode, errcode: 0.5 }] },
    { version: 1, root: 0, nodes: [{ ...validNode, errcode: 2 ** 31 }] },
    {
      version: 1,
      root: 0,
      nodes: [
        { type: "coordinator-contention", name: "Error", message: "invalid", family: "other" },
      ],
    },
    {
      version: 1,
      root: 0,
      nodes: [
        {
          type: "state-lease",
          leaseCode: "OPENCLAW_STATE_LEASE_LOST",
          code: "OPENCLAW_STATE_LEASE_HELD",
          name: "OpenClawStateLeaseError",
          message: "mismatched lease classification",
        },
      ],
    },
    { version: 1, root: 0, nodes: [{ ...validNode, stack: "not transported" }] },
    {
      version: 1,
      root: 0,
      nodes: [{ type: "aggregate", name: "AggregateError", message: "missing edges" }],
    },
    {
      version: 1,
      root: 0,
      nodes: [{ type: "error", name: "Error", message: "unrelated" }, validNode],
    },
    {
      version: 1,
      root: 0,
      nodes: [
        {
          type: "agent-media-migration",
          name: "Error",
          message: "invalid version",
          pathname: "/fixture/agent.sqlite",
          schemaVersion: -1,
        },
      ],
    },
  ])("rejects malformed or noncanonical payload %#", (payload) => {
    const retained = new Error("ordinary transport failure");
    retainOpenClawStateWorkerErrorPayload(retained, payload);
    expect(hydrateOpenClawStateWorkerError(retained)).toBe(retained);
    expect(hydrateOpenClawStateWorkerError(retained, { includeOrdinary: true })).toBe(retained);
  });
});
