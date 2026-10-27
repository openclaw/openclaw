import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { decodePostgresError } from "./postgres-sync/protocol.js";
import {
  classifyGatewayStorageFailure,
  isLocalStorageOutcomeError,
} from "./sqlite-error-diagnostics.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  isSqliteWorkerError,
  retainSqliteWorkerErrorCode,
  SqliteWorkerError,
  wrapSqliteWorkerError,
} from "./sqlite-worker-contract.js";

const unsafeGetter = () =>
  vi.fn(() => {
    throw new Error("Diagnostic user code must not execute");
  });
const unknownOutcome = () => new SqliteWorkerError("Unknown native settlement", "outcome-unknown");
const codedError = (code: string) => Object.assign(new Error("Persistence failed"), { code });
const wrap = (...causes: Error[]) =>
  wrapSqliteWorkerError("Unknown outcome", "outcome-unknown", ...causes);

it.each([false, true])("deduplicates failure causes (copied: %s)", (copied) => {
  const failure = codedError("EIO");
  const duplicate = copied
    ? Object.assign(new Error(failure.message), { code: failure.code })
    : failure;
  expect(wrap(failure, duplicate).cause).toBe(failure);
});

it.each(["code", "nested cause"] as const)("retains failures with a distinct %s", (difference) => {
  const failure =
    difference === "code"
      ? codedError("REPLY_LOST")
      : new Error("Persistence failed", { cause: new Error("Reply lost") });
  const storageFailure =
    difference === "code"
      ? codedError("SQLITE_FULL")
      : new Error("Persistence failed", {
          cause: Object.assign(new Error("Disk full"), { code: "SQLITE_FULL" }),
        });
  const wrapped = wrap(failure, storageFailure);
  expect(wrapped.cause).toBeInstanceOf(AggregateError);
  expect(wrapped.cause).toMatchObject({ errors: [failure, storageFailure] });
  expect(classifyGatewayStorageFailure(wrapped)).toBe("session_actor_reconciliation");
});
it.each([false, true])("keeps rollback nonterminal (cleanup: %s)", (cleanup) => {
  const cancellation = decodePostgresError({
    name: "error",
    message: "PRIVATE_CANCELLED_STATEMENT",
    code: "57014",
  });
  const failure = Object.assign(new SqliteWorkerError("PRIVATE_ROLLBACK", "unavailable"), {
    cause: cleanup
      ? new AggregateError([cancellation, new Error("PRIVATE_CLEANUP")], "PRIVATE_MULTI", {
          cause: cancellation,
        })
      : cancellation,
  });
  expect(classifyGatewayStorageFailure(failure)).toBe("unavailable");
  expect(isLocalStorageOutcomeError(failure)).toBe(false);
  expect(isSqliteWorkerError(failure, "unavailable")).toBe(true);
});

it("classifies canonical and impersonated unavailability", () => {
  const unavailable = new SqliteWorkerError("PRIVATE_ROLLBACK", "unavailable");
  expect(classifyGatewayStorageFailure(unavailable)).toBe("unavailable");
  expect(isSqliteWorkerError(unavailable, "unavailable")).toBe(true);
  expect(isLocalStorageOutcomeError(unavailable)).toBe(false);
  const unknown = new SqliteWorkerError("PRIVATE_UNCONFIRMED", "outcome-unknown");
  const wrapped = new Error("PRIVATE_WRAPPER", {
    cause: new AggregateError([unavailable, unknown], "PRIVATE_MULTI"),
  });
  expect(classifyGatewayStorageFailure(wrapped)).toBe("session_actor_reconciliation");
  expect(isLocalStorageOutcomeError(wrapped)).toBe(true);
  expect(
    classifyGatewayStorageFailure(
      Object.assign(new Error("PRIVATE_PROVIDER"), {
        name: "SqliteWorkerError",
        code: "unavailable",
      }),
    ),
  ).toBeUndefined();
});

it.each([false, true])("ignores throwing metadata (native: %s)", (native) => {
  const unsafe = unsafeGetter();
  const failure = native
    ? Object.assign(new Error("Synthetic capacity failure"), { code: "SQLITE_FULL" })
    : {};
  const fields = native
    ? ["errorType", "name"]
    : ["errorCode", "code", "errcode", "errstr", "errorMessage", "message"];
  Object.defineProperties(failure, Object.fromEntries(fields.map((key) => [key, { get: unsafe }])));
  expect(classifyGatewayStorageFailure(failure)).toBe(native ? "SQLITE_FULL" : undefined);
  expect(unsafe).not.toHaveBeenCalled();
});

it.each(["cause", "aggregate errors", "aggregate slot"] as const)(
  "preserves unknown outcomes with a throwing %s",
  (accessor) => {
    const unsafe = unsafeGetter();
    const primary = unknownOutcome();
    const aggregate = new AggregateError([], "Cleanup", { cause: primary });
    const errors = [primary];
    aggregate.errors = errors;
    const targets = { cause: primary, "aggregate errors": aggregate, "aggregate slot": errors };
    const key = accessor === "cause" ? "cause" : accessor === "aggregate errors" ? "errors" : "0";
    Object.defineProperty(targets[accessor], key, { get: unsafe });
    const failure = accessor === "cause" ? primary : aggregate;
    expect(classifyGatewayStorageFailure(failure)).toBe("session_actor_reconciliation");
    expect(unsafe).not.toHaveBeenCalled();
  },
);

it.each([false, true])("finds outcomes in cyclic aggregates (foreign: %s)", (foreign) => {
  const error = unknownOutcome();
  const failure: unknown = foreign
    ? runInNewContext("new AggregateError([error], 'Cross-realm cleanup')", { error })
    : new AggregateError([new Error("Nested", { cause: error })], "Cleanup");
  Object.defineProperty(failure, "cause", { value: failure });
  expect(failure instanceof AggregateError).toBe(!foreign);
  expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
  const retained = retainSqliteWorkerErrorCode(new AggregateError([], "Cleanup"), error);
  expect(isSqliteWorkerError(retained, "outcome-unknown")).toBe(false);
  expect(hasSqliteWorkerOutcomeUnknown(retained)).toBe(true);
});

it("never invokes getters, proxy traps, or array iterators", () => {
  const unsafe = unsafeGetter();
  const ordinary = new Error("Ordinary cleanup");
  Object.defineProperty(ordinary, "cause", { get: unsafe });
  Object.defineProperty(ordinary, "code", { get: unsafe });
  expect(hasSqliteWorkerOutcomeUnknown(ordinary)).toBe(false);
  expect(
    hasSqliteWorkerOutcomeUnknown(new Proxy(ordinary, { getOwnPropertyDescriptor: unsafe })),
  ).toBe(false);
  const proxyPrototype = new Error("Opaque prototype");
  Object.setPrototypeOf(proxyPrototype, new Proxy(Error.prototype, { getPrototypeOf: unsafe }));
  expect(hasSqliteWorkerOutcomeUnknown(proxyPrototype)).toBe(false);

  const errors = [undefined, unknownOutcome()];
  Object.defineProperty(errors, "0", { get: unsafe });
  Object.defineProperty(errors, Symbol.iterator, { value: unsafe });
  const aggregate = new AggregateError([], "Cleanup");
  Object.defineProperty(aggregate, "errors", { value: errors });
  expect(hasSqliteWorkerOutcomeUnknown(aggregate)).toBe(true);
  expect(unsafe).not.toHaveBeenCalled();
});
