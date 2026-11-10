import { expect, it } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { decodePostgresError } from "../infra/postgres-sync/protocol.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";
import { errorShapeFromError } from "./error-shape.js";

const workerError = (code: ConstructorParameters<typeof SqliteWorkerError>[1]) =>
  new SqliteWorkerError("PRIVATE_WORKER", code);
const diskError = () => Object.assign(new Error("PRIVATE_DISK"), { code: "SQLITE_FULL" });
const envelope = (primary: Error, cleanup = new Error("PRIVATE_CLEANUP")) =>
  new AggregateError([primary, cleanup], "PRIVATE_AGGREGATE", { cause: primary });

function expectStorageFailure(
  result: ReturnType<typeof errorShapeFromError>,
  code: string,
  retryable: boolean | undefined,
  messages: RegExp[],
) {
  expect(result).toMatchObject({ code: ErrorCodes.UNAVAILABLE, details: { code } });
  if (retryable === undefined) {
    expect(result).not.toHaveProperty("retryable");
  } else {
    expect(result.retryable).toBe(retryable);
  }
  for (const message of messages) {
    expect(result.message).toMatch(message);
  }
  expect(result.message).not.toContain("PRIVATE_");
}

it.each([false, true])(
  "fences uncertain siblings at the wire boundary (contention: %s)",
  (contention) => {
    const primary = Object.assign(
      new Error("PRIVATE_PUBLICATION"),
      contention ? { code: "SQLITE_BUSY" } : {},
    );
    const packet = JSON.stringify(
      errorShapeFromError(
        ErrorCodes.INVALID_REQUEST,
        envelope(primary, workerError("outcome-unknown")),
        { retryable: true },
      ),
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

it.each([
  ["omitted retry", workerError("unavailable"), undefined, undefined],
  ["direct", workerError("unavailable"), true, true],
  ["cleanup", envelope(workerError("unavailable")), true, true],
  [
    "uncertain cleanup",
    envelope(workerError("unavailable"), workerError("outcome-unknown")),
    true,
    false,
  ],
  ["retry refused", workerError("unavailable"), false, false],
] as const)(
  "renders confirmed rollback without changing retry authority: %s",
  (_name, error, requested, retryable) => {
    const result = errorShapeFromError(
      ErrorCodes.UNAVAILABLE,
      error,
      requested === undefined ? { message: "PRIVATE_DISPATCH_FAILURE" } : { retryable: requested },
    );
    expectStorageFailure(result, "unavailable", retryable, [
      /connection|database/i,
      /rolled back/i,
      /nothing.*saved/i,
      /retry|try again/i,
    ]);
  },
);

it("renders PostgreSQL cancellation without granting automatic retry", () => {
  const error = decodePostgresError({
    name: "error",
    code: "57014",
    message: "PRIVATE_QUERY_DETAIL",
  });
  expectStorageFailure(
    errorShapeFromError(ErrorCodes.INVALID_REQUEST, error, { retryable: true }),
    "57014",
    false,
    [/cancel|timeout/i, /check|retry/i],
  );
});

it("reports ended incognito sessions through cleanup wrappers", () => {
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
  [diskError(), true],
  [Object.assign(new Error("write failed"), { code: "ERR_SQLITE_ERROR", errcode: 13 }), true],
  [new Error("database or disk is full"), true],
  [
    new Error("cleanup failed", {
      cause: Object.assign(new Error("write failed"), { code: "ENOSPC" }),
    }),
    true,
  ],
  [envelope(diskError(), workerError("outcome-unknown")), false],
  [new AggregateError([diskError(), envelope(new Error("PRIVATE_CLOSE"))], "PRIVATE_MULTI"), true],
] as const)("renders disk-full failures without exposing internal text: %s", (error, retryable) => {
  expect(
    errorShapeFromError(ErrorCodes.INVALID_REQUEST, error, { message: "internal handler failure" }),
  ).toMatchObject({
    code: ErrorCodes.UNAVAILABLE,
    retryable,
    details: { code: "SQLITE_FULL" },
    message:
      "OpenClaw couldn't save your conversation because the disk is full. Free up space on the computer running OpenClaw before continuing.",
  });
});
