import { describe, expect, it } from "vitest";
import {
  isBenignUncaughtExceptionError,
  isTransientNetworkError,
  isTransientSqliteError,
  isTransientUnhandledRejectionError,
} from "./unhandled-rejections.js";

const codedError = (code: string, message = code) => Object.assign(new Error(message), { code });

describe("network rejection regressions", () => {
  it("recognizes destroyed HTTP/2 sessions, including wrapped failures", () => {
    const error = codedError("ERR_HTTP2_INVALID_SESSION", "The session has been destroyed");
    expect(isTransientNetworkError(error)).toBe(true);
    expect(isTransientNetworkError(new Error("model call failed", { cause: error }))).toBe(true);
    expect(isTransientNetworkError(new Error("ERR_HTTP2_INVALID_SESSION"))).toBe(true);
  });

  it("recognizes wrapped fetch failures without swallowing HTTP failures", () => {
    expect(
      isTransientNetworkError(new Error("Failed to get gateway information: fetch failed")),
    ).toBe(true);
    expect(isTransientNetworkError(new Error("Web fetch failed (404): Not Found"))).toBe(false);
  });

  it("recognizes upstream-connect failures wrapped as JSON parse errors", () => {
    expect(
      isTransientNetworkError(
        new Error(
          `Failed to get gateway information from Discord: Unexpected token 'u', "upstream connect error or disconnect/reset before headers. reset reason: overflow" is not valid JSON`,
        ),
      ),
    ).toBe(true);
  });

  it("keeps permanent WebSocket closes fatal despite transient wrapper text", () => {
    const cause = codedError(
      "ERR_WEBSOCKET_NON_RETRYABLE_CLOSE",
      "WebSocket closed 1008 policy violation: ECONNRESET",
    );
    expect(isTransientNetworkError(new Error("socket hang up", { cause }))).toBe(false);
  });
});

describe("SQLite rejection classification", () => {
  it.each([
    codedError("SQLITE_CANTOPEN"),
    Object.assign(new Error("unable to open database file"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 14,
    }),
    new Error("SQLITE_BUSY: database is locked"),
  ])("recognizes transient SQLite failure %#", (error) => {
    expect(isTransientSqliteError(error)).toBe(true);
  });

  it("keeps constraint violations fatal", () => {
    expect(
      isTransientSqliteError(codedError("SQLITE_CONSTRAINT", "UNIQUE constraint failed")),
    ).toBe(false);
    expect(
      isTransientSqliteError({
        code: "ERR_SQLITE_ERROR",
        message: "constraint failed",
        errcode: 19,
        errstr: "constraint failed",
      }),
    ).toBe(false);
  });
});

describe("watcher rejection classification", () => {
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
});

it("restricts benign uncaught exceptions to known transport failures", () => {
  expect(isBenignUncaughtExceptionError(codedError("EPIPE"))).toBe(true);
  expect(isBenignUncaughtExceptionError(codedError("ENETDOWN"))).toBe(true);
  expect(isBenignUncaughtExceptionError(new Error("connect ENETDOWN 192.0.2.1:443"))).toBe(true);
  expect(
    isBenignUncaughtExceptionError(
      new Error("model call failed", { cause: codedError("ERR_HTTP2_INVALID_SESSION") }),
    ),
  ).toBe(true);
  expect(
    isBenignUncaughtExceptionError(
      new Error("reconnect failed", {
        cause: new Error("WebSocket was closed before the connection was established"),
      }),
    ),
  ).toBe(true);
  expect(
    isBenignUncaughtExceptionError(
      new Error("fetch failed", { cause: new TypeError("terminated") }),
    ),
  ).toBe(true);
  expect(isBenignUncaughtExceptionError(codedError("SQLITE_BUSY"))).toBe(false);
  expect(isBenignUncaughtExceptionError(codedError("ECONNRESET"))).toBe(false);
  expect(isBenignUncaughtExceptionError(new Error("terminated"))).toBe(false);
  expect(isBenignUncaughtExceptionError(new TypeError("terminated unexpectedly"))).toBe(false);
  expect(
    isBenignUncaughtExceptionError(
      new Error("WebSocket error: WebSocket was closed before the connection was established"),
    ),
  ).toBe(false);
});
