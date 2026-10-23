import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { classifyGatewayStorageFailure } from "./sqlite-error-diagnostics.js";
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
      expect(classifyGatewayStorageFailure(wrapped)).toBe("SQLITE_FULL");
    },
  );
});

describe("unknown worker outcome classification", () => {
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
