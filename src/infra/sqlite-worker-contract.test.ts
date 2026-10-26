import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
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

describe("worker failure causes", () => {
  it.each([false, true])(
    "preserves one direct cause for duplicate failures (copied: %s)",
    (copied) => {
      const failure = Object.assign(new Error("Run lease admission reply was lost"), {
        code: "EIO",
      });
      const duplicate = copied
        ? Object.assign(new Error(failure.message), { code: failure.code })
        : failure;
      expect(
        wrapSqliteWorkerError("Unknown outcome", "outcome-unknown", failure, duplicate).cause,
      ).toBe(failure);
    },
  );

  it.each(["code", "nested cause"] as const)(
    "retains failures with a distinct %s",
    (difference) => {
      const failure =
        difference === "code"
          ? Object.assign(new Error("Persistence failed"), { code: "REPLY_LOST" })
          : new Error("Persistence failed", { cause: new Error("Reply lost") });
      const storageFailure =
        difference === "code"
          ? Object.assign(new Error("Persistence failed"), { code: "SQLITE_FULL" })
          : new Error("Persistence failed", {
              cause: Object.assign(new Error("Disk full"), { code: "SQLITE_FULL" }),
            });
      const wrapped = wrapSqliteWorkerError(
        "Unknown outcome",
        "outcome-unknown",
        failure,
        storageFailure,
      );
      expect(wrapped.cause).toBeInstanceOf(AggregateError);
      expect(wrapped.cause).toMatchObject({ errors: [failure, storageFailure] });
      expect(classifyGatewayStorageFailure(wrapped)).toBe("session_actor_reconciliation");
    },
  );
});

describe("worker outcome classification", () => {
  it.each([false, true])(
    "keeps a canonical rollback outside terminal cancellation handling (cleanup: %s)",
    (cleanup) => {
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
    },
  );

  it("presents canonical unavailability without changing execution classification", () => {
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

  it.each(["errorCode", "code", "errcode", "errstr", "errorMessage", "message"])(
    "ignores a throwing %s field on an ordinary failure",
    (field) => {
      const unsafe = vi.fn(() => {
        throw new Error("Diagnostic access must not replace the original tool failure");
      });
      const failure = Object.defineProperty({}, field, { get: unsafe });
      expect(classifyGatewayStorageFailure(failure)).toBeUndefined();
      expect(unsafe).not.toHaveBeenCalled();
    },
  );

  it.each(["errorType", "name"])("ignores a throwing %s cancellation marker", (marker) => {
    const unsafe = vi.fn(() => {
      throw new Error("Marker access must not replace the original failure");
    });
    const failure = Object.assign(new Error("Synthetic capacity failure"), { code: "SQLITE_FULL" });
    Object.defineProperty(failure, marker, { get: unsafe });
    expect(classifyGatewayStorageFailure(failure)).toBe("SQLITE_FULL");
    expect(unsafe).not.toHaveBeenCalled();
  });

  it.each(["cause", "aggregate errors", "aggregate slot"] as const)(
    "keeps unknown outcomes when the %s accessor rejects inspection",
    (accessor) => {
      const unsafe = vi.fn(() => {
        throw new Error("Diagnostic access must not replace the original failure");
      });
      const primary = new SqliteWorkerError("Unknown native settlement", "outcome-unknown");
      let failure: Error;
      if (accessor === "cause") {
        Object.defineProperty(primary, "cause", { get: unsafe });
        failure = primary;
      } else {
        const aggregate = new AggregateError([], "Cleanup", { cause: primary });
        if (accessor === "aggregate errors") {
          Object.defineProperty(aggregate, "errors", { get: unsafe });
        } else {
          const errors = [primary];
          Object.defineProperty(errors, "0", { get: unsafe });
          aggregate.errors = errors;
        }
        failure = aggregate;
      }
      expect(classifyGatewayStorageFailure(failure)).toBe("session_actor_reconciliation");
      expect(unsafe).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "finds canonical outcomes in cyclic aggregates (foreign realm: %s)",
    (foreign) => {
      const error = new SqliteWorkerError("Unknown native settlement", "outcome-unknown");
      const failure: unknown = foreign
        ? runInNewContext("new AggregateError([error], 'Cross-realm cleanup')", { error })
        : new AggregateError([new Error("Nested", { cause: error })], "Cleanup");
      Object.defineProperty(failure, "cause", { value: failure });
      expect(failure instanceof AggregateError).toBe(!foreign);
      expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
      const retained = retainSqliteWorkerErrorCode(new AggregateError([], "Cleanup"), error);
      expect(isSqliteWorkerError(retained, "outcome-unknown")).toBe(false);
      expect(hasSqliteWorkerOutcomeUnknown(retained)).toBe(true);
    },
  );

  it("does not invoke getters, proxies or supplied array iterators while inspecting errors", () => {
    const unsafe = vi.fn(() => {
      throw new Error("Diagnostic user code must not execute");
    });
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

    const errors = [undefined, new SqliteWorkerError("Unknown", "outcome-unknown")];
    Object.defineProperty(errors, "0", { get: unsafe });
    Object.defineProperty(errors, Symbol.iterator, { value: unsafe });
    const aggregate = new AggregateError([], "Cleanup");
    Object.defineProperty(aggregate, "errors", { value: errors });
    expect(hasSqliteWorkerOutcomeUnknown(aggregate)).toBe(true);
    expect(unsafe).not.toHaveBeenCalled();
  });
});
