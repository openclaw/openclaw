import { expect, it } from "vitest";
import {
  isBenignUncaughtExceptionError,
  isTransientNetworkError,
  isTransientSqliteError,
  isTransientUnhandledRejectionError,
} from "./unhandled-rejections.js";

const codedError = (code: string, message = code) => Object.assign(new Error(message), { code });
const causedBy = (cause: unknown, message = "model call failed") => new Error(message, { cause });
const http2 = codedError("ERR_HTTP2_INVALID_SESSION", "The session has been destroyed");
const handshake = "WebSocket was closed before the connection was established";
type Classification = { error: unknown; transient: boolean };
type BenignClassification = { error: Error; benign: boolean };

it.each`
  error                                                                                                                                                                                       | transient
  ${http2}                                                                                                                                                                                    | ${true}
  ${causedBy(http2)}                                                                                                                                                                          | ${true}
  ${new Error("ERR_HTTP2_INVALID_SESSION")}                                                                                                                                                   | ${true}
  ${new Error("Failed to get gateway information: fetch failed")}                                                                                                                             | ${true}
  ${new Error("Web fetch failed (404): Not Found")}                                                                                                                                           | ${false}
  ${new Error(`Failed to get gateway information from Discord: Unexpected token 'u', "upstream connect error or disconnect/reset before headers. reset reason: overflow" is not valid JSON`)} | ${true}
  ${causedBy(codedError("ERR_WEBSOCKET_NON_RETRYABLE_CLOSE", "WebSocket closed 1008 policy violation: ECONNRESET"), "socket hang up")}                                                        | ${false}
`(
  "classifies network rejection $error as transient=$transient",
  ({ error, transient }: Classification) => {
    expect(isTransientNetworkError(error)).toBe(transient);
  },
);

it.each`
  error                                                                                                   | transient
  ${codedError("SQLITE_CANTOPEN")}                                                                        | ${true}
  ${Object.assign(new Error("unable to open database file"), { code: "ERR_SQLITE_ERROR", errcode: 14 })}  | ${true}
  ${new Error("SQLITE_BUSY: database is locked")}                                                         | ${true}
  ${codedError("SQLITE_CONSTRAINT", "UNIQUE constraint failed")}                                          | ${false}
  ${{ code: "ERR_SQLITE_ERROR", message: "constraint failed", errcode: 19, errstr: "constraint failed" }} | ${false}
`(
  "classifies SQLite rejection $error as transient=$transient",
  ({ error, transient }: Classification) => {
    expect(isTransientSqliteError(error)).toBe(transient);
  },
);

it.each([
  [null, false],
  ["string error", false],
  [codedError("ENOSPC", "watcher error: ENOSPC"), true],
  [codedError("ENOSPC", "write failed: no space left on device"), false],
  [new Error("file watcher: no space left on device"), true],
  [new Error("watcher error: ENOSPC"), false],
])("requires watcher resource exhaustion for input %#", (error, transient) => {
  expect(isTransientUnhandledRejectionError(error)).toBe(transient);
});

it.each`
  error                                                    | benign
  ${codedError("EPIPE")}                                   | ${true}
  ${codedError("ENETDOWN")}                                | ${true}
  ${new Error("connect ENETDOWN 192.0.2.1:443")}           | ${true}
  ${causedBy(codedError("ERR_HTTP2_INVALID_SESSION"))}     | ${true}
  ${causedBy(new Error(handshake), "reconnect failed")}    | ${true}
  ${causedBy(new TypeError("terminated"), "fetch failed")} | ${true}
  ${codedError("SQLITE_BUSY")}                             | ${false}
  ${codedError("ECONNRESET")}                              | ${false}
  ${new Error("terminated")}                               | ${false}
  ${new TypeError("terminated unexpectedly")}              | ${false}
  ${new Error(`WebSocket error: ${handshake}`)}            | ${false}
`(
  "restricts benign uncaught exceptions: $error benign=$benign",
  ({ error, benign }: BenignClassification) => {
    expect(isBenignUncaughtExceptionError(error)).toBe(benign);
  },
);
