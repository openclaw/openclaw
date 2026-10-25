import { expect, it } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { settleWithCleanup } from "../infra/error-graph-internal.js";
import { decodePostgresError } from "../infra/postgres-sync/protocol.js";
import { SqliteWorkerError, wrapSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";
import { errorShapeFromError } from "./error-shape.js";

it.each([false, true])(
  "fences an uncertain sibling at the wire boundary (contention: %s)",
  (contention) => {
    const primary = Object.assign(
      new Error("PRIVATE_PUBLICATION"),
      contention ? { code: "SQLITE_BUSY" } : {},
    );
    const unknown = new SqliteWorkerError("PRIVATE_UNCONFIRMED", "outcome-unknown");
    const failure = new AggregateError([primary, unknown], primary.message, { cause: primary });
    const packet = JSON.stringify(
      errorShapeFromError(ErrorCodes.INVALID_REQUEST, failure, { retryable: true }),
    );
    const wire: unknown = JSON.parse(packet);
    expect(wire).toMatchObject({ retryable: false });
    if (!contention) {
      expect(wire).toMatchObject({
        code: ErrorCodes.UNAVAILABLE,
        details: { code: "session_actor_reconciliation" },
        message: expect.stringMatching(/check.*history/i),
      });
    }
    expect(wire).not.toHaveProperty("cause");
  },
);

it("preserves omitted retry authority when rendering a canonical unavailable outcome", () => {
  const error = new SqliteWorkerError("PRIVATE_ROLLBACK", "unavailable");
  const result = errorShapeFromError(ErrorCodes.UNAVAILABLE, error, {
    message: "PRIVATE_DISPATCH_FAILURE",
  });
  expect(result).toMatchObject({
    code: ErrorCodes.UNAVAILABLE,
    details: { code: "unavailable" },
  });
  expect(result).not.toHaveProperty("retryable");
  expect(result.message).toMatch(/connection|database/i);
  expect(result.message).toMatch(/retry|try again/i);
  expect(result.message).not.toContain("PRIVATE_");
});

it.each(["direct", "cleanup", "uncertain-cleanup", "retry-refused"])(
  "renders a canonical unavailable outcome without changing retry authority (%s)",
  (scenario) => {
    const primary = new SqliteWorkerError("PRIVATE_ROLLBACK", "unavailable");
    const cleanup =
      scenario === "uncertain-cleanup"
        ? new SqliteWorkerError("PRIVATE_CLEANUP", "outcome-unknown")
        : new Error("PRIVATE_CLEANUP");
    const error =
      scenario === "direct" || scenario === "retry-refused"
        ? primary
        : new AggregateError([primary, cleanup], "PRIVATE_AGGREGATE", { cause: primary });
    const result = errorShapeFromError(ErrorCodes.UNAVAILABLE, error, {
      retryable: scenario !== "retry-refused",
    });
    expect(result).toMatchObject({
      code: ErrorCodes.UNAVAILABLE,
      details: { code: "unavailable" },
      retryable: scenario !== "uncertain-cleanup" && scenario !== "retry-refused",
    });
    expect(result.message).toMatch(/connection|database/i);
    expect(result.message).toMatch(/rolled back/i);
    expect(result.message).toMatch(/nothing.*saved/i);
    expect(result.message).toMatch(/retry|try again/i);
    expect(result.message).not.toContain("PRIVATE_");
  },
);

it.each([false, true])(
  "renders an unknown outcome with guidance and no retry grant (nested: %s)",
  (nested) => {
    const primary = new SqliteWorkerError("PRIVATE_DATABASE_DETAIL", "outcome-unknown");
    const error = nested
      ? new AggregateError([primary, new Error("PRIVATE_CLEANUP_DETAIL")], "PRIVATE_AGGREGATE", {
          cause: primary,
        })
      : primary;
    const result = errorShapeFromError(ErrorCodes.INVALID_REQUEST, error, { retryable: true });
    expect(result).toMatchObject({ code: ErrorCodes.UNAVAILABLE, retryable: false });
    expect(result.message).toMatch(/confirm|saved/i);
    expect(result.message).toMatch(/check|reopen|retry/i);
    expect(result.message).not.toContain("PRIVATE_");
  },
);

it("keeps cleanup storage failures secondary to an unknown primary outcome", () => {
  const primary = new SqliteWorkerError("PRIVATE_PRIMARY", "outcome-unknown");
  const cleanup = Object.assign(new Error("PRIVATE_CLEANUP"), { code: "SQLITE_FULL" });
  const error = new Error(primary.message, {
    cause: new AggregateError([primary, cleanup], "PRIVATE_AGGREGATE", { cause: primary }),
  });
  const result = errorShapeFromError(ErrorCodes.INVALID_REQUEST, error);
  expect(result).toMatchObject({ code: ErrorCodes.UNAVAILABLE, retryable: false });
  expect(result.message).toMatch(/confirm|saved/i);
  expect(result.message).not.toContain("PRIVATE_");
});

it("keeps an explicit disk failure primary when only cleanup has an unknown outcome", () => {
  const primary = Object.assign(new Error("PRIVATE_PRIMARY"), { code: "SQLITE_FULL" });
  const cleanup = new SqliteWorkerError("PRIVATE_CLEANUP", "outcome-unknown");
  const error = new AggregateError([primary, cleanup], "PRIVATE_AGGREGATE", { cause: primary });
  expect(errorShapeFromError(ErrorCodes.INVALID_REQUEST, error)).toMatchObject({
    code: ErrorCodes.UNAVAILABLE,
    retryable: false,
    details: { code: "SQLITE_FULL" },
  });
});

it.each(["worker", "settlement"] as const)(
  "retains uncertainty when the %s envelope also contains a cleanup disk failure",
  async (envelope) => {
    const primary = new SqliteWorkerError("PRIVATE_PRIMARY", "outcome-unknown");
    const cleanup = Object.assign(new Error("PRIVATE_CLEANUP"), { code: "SQLITE_FULL" });
    let error: unknown;
    if (envelope === "worker") {
      error = wrapSqliteWorkerError("PRIVATE_OUTCOME", "outcome-unknown", primary, cleanup);
    } else {
      try {
        await settleWithCleanup(
          Promise.reject(primary),
          () => {
            throw cleanup;
          },
          "PRIVATE_SETTLEMENT",
        );
      } catch (failure) {
        error = failure;
      }
    }
    const result = errorShapeFromError(ErrorCodes.INVALID_REQUEST, error);
    expect(result).toMatchObject({
      code: ErrorCodes.UNAVAILABLE,
      retryable: false,
      details: { code: "session_actor_reconciliation" },
    });
    expect(result.message).toMatch(/confirm|saved/i);
    expect(result.message).toMatch(/check|retry/i);
    expect(result.message).not.toContain("PRIVATE_");
  },
);

it("renders a native PostgreSQL cancellation without granting an automatic retry", () => {
  const result = errorShapeFromError(
    ErrorCodes.INVALID_REQUEST,
    decodePostgresError({
      name: "error",
      code: "57014",
      message: "PRIVATE_QUERY_DETAIL",
    }),
    { retryable: true },
  );
  expect(result).toMatchObject({ code: ErrorCodes.UNAVAILABLE, retryable: false });
  expect(result.message).toMatch(/cancel|timeout/i);
  expect(result.message).toMatch(/check|retry/i);
  expect(result.message).not.toContain("PRIVATE_");
});

it("does not let a nested cleanup aggregate hide an independent disk failure", () => {
  const disk = Object.assign(new Error("PRIVATE_DISK"), { code: "SQLITE_FULL" });
  const close = new Error("PRIVATE_CLOSE");
  const cleanup = new AggregateError([close], "PRIVATE_CLEANUP", { cause: close });
  const result = errorShapeFromError(
    ErrorCodes.INVALID_REQUEST,
    new AggregateError([disk, cleanup], "PRIVATE_MULTI"),
  );
  expect(result).toMatchObject({
    code: ErrorCodes.UNAVAILABLE,
    retryable: true,
    details: { code: "SQLITE_FULL" },
  });
  expect(result.message).not.toContain("PRIVATE_");
});

it.each([
  new Error("PRIVATE_FAILURE"),
  decodePostgresError({ name: "error", code: "57014", message: "PRIVATE_CANCEL" }),
])("retains outer uncertainty while reading the primary cause", (primary) => {
  const error = wrapSqliteWorkerError(
    "PRIVATE_OUTCOME",
    "outcome-unknown",
    new AggregateError([primary, new Error("PRIVATE_CLEANUP")], "PRIVATE_ENVELOPE", {
      cause: primary,
    }),
  );
  const result = errorShapeFromError(ErrorCodes.INVALID_REQUEST, error);
  expect(result).toMatchObject({
    code: ErrorCodes.UNAVAILABLE,
    retryable: false,
    details: { code: "session_actor_reconciliation" },
  });
  expect(result.message).toMatch(/confirm|saved/i);
  expect(result.message).not.toContain("PRIVATE_");
});

it("reports ended incognito sessions as typed nonretryable client failures through cleanup wrappers", () => {
  const ended = new IncognitoSessionEndedError();
  const error = new AggregateError([new Error("cleanup"), ended], "operation failed");
  expect(
    errorShapeFromError(ErrorCodes.INVALID_REQUEST, error, {
      message: "generic failure",
      retryable: true,
    }),
  ).toMatchObject({
    code: ErrorCodes.UNAVAILABLE,
    message: ended.message,
    retryable: false,
    details: { code: "INCOGNITO_SESSION_ENDED" },
  });
});

it.each([
  Object.assign(new Error("write failed"), { code: "SQLITE_FULL" }),
  Object.assign(new Error("write failed"), { code: "ERR_SQLITE_ERROR", errcode: 13 }),
  new Error("database or disk is full"),
  new Error("cleanup failed", {
    cause: Object.assign(new Error("write failed"), { code: "ENOSPC" }),
  }),
])("classifies a disk-full failure without exposing internal text: %s", (error) => {
  expect(
    errorShapeFromError(ErrorCodes.INVALID_REQUEST, error, { message: "internal handler failure" }),
  ).toMatchObject({
    code: ErrorCodes.UNAVAILABLE,
    message:
      "OpenClaw couldn't save your conversation because the disk is full. Free up space on the computer running OpenClaw before continuing.",
    retryable: true,
    details: { code: "SQLITE_FULL" },
  });
});
