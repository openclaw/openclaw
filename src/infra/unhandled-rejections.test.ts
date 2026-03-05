import { describe, expect, it } from "vitest";
import {
  isAbortError,
  isTransientNetworkError,
  isTlsSocketNullDeref,
} from "./unhandled-rejections.js";

describe("isAbortError", () => {
  it("returns true for error with name AbortError", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(isAbortError(error)).toBe(true);
  });

  it('returns true for error with "This operation was aborted" message', () => {
    const error = new Error("This operation was aborted");
    expect(isAbortError(error)).toBe(true);
  });

  it("returns true for undici-style AbortError", () => {
    // Node's undici throws errors with this exact message
    const error = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(isAbortError(error)).toBe(true);
  });

  it("returns true for object with AbortError name", () => {
    expect(isAbortError({ name: "AbortError", message: "test" })).toBe(true);
  });

  it("returns false for regular errors", () => {
    expect(isAbortError(new Error("Something went wrong"))).toBe(false);
    expect(isAbortError(new TypeError("Cannot read property"))).toBe(false);
    expect(isAbortError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("returns false for errors with similar but different messages", () => {
    expect(isAbortError(new Error("Operation aborted"))).toBe(false);
    expect(isAbortError(new Error("aborted"))).toBe(false);
    expect(isAbortError(new Error("Request was aborted"))).toBe(false);
  });

  it.each([null, undefined, "string error", 42, { message: "plain object" }])(
    "returns false for non-abort input %#",
    (value) => {
      expect(isAbortError(value)).toBe(false);
    },
  );
});

describe("isTransientNetworkError", () => {
  it("returns true for errors with transient network codes", () => {
    const codes = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "ECONNABORTED",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ];

    for (const code of codes) {
      const error = Object.assign(new Error("test"), { code });
      expect(isTransientNetworkError(error), `code: ${code}`).toBe(true);
    }
  });

  it('returns true for TypeError with "fetch failed" message', () => {
    const error = new TypeError("fetch failed");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for fetch failed with network cause", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for fetch failed with unclassified cause", () => {
    const cause = Object.assign(new Error("unknown socket state"), { code: "UNKNOWN" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for nested cause chain with network error", () => {
    const innerCause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const outerCause = Object.assign(new Error("wrapper"), { cause: innerCause });
    const error = Object.assign(new TypeError("fetch failed"), { cause: outerCause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for Slack request errors that wrap network codes in .original", () => {
    const error = Object.assign(new Error("A request error occurred: getaddrinfo EAI_AGAIN"), {
      code: "slack_webapi_request_error",
      original: {
        errno: -3001,
        code: "EAI_AGAIN",
        syscall: "getaddrinfo",
        hostname: "slack.com",
      },
    });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for network codes nested in .data payloads", () => {
    const error = {
      code: "slack_webapi_request_error",
      message: "A request error occurred",
      data: {
        code: "EAI_AGAIN",
      },
    };
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for AggregateError containing network errors", () => {
    const networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const error = new AggregateError([networkError], "Multiple errors");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns false for regular errors without network codes", () => {
    expect(isTransientNetworkError(new Error("Something went wrong"))).toBe(false);
    expect(isTransientNetworkError(new TypeError("Cannot read property"))).toBe(false);
    expect(isTransientNetworkError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("returns false for errors with non-network codes", () => {
    const error = Object.assign(new Error("test"), { code: "INVALID_CONFIG" });
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns false for Slack request errors without network indicators", () => {
    const error = Object.assign(new Error("A request error occurred"), {
      code: "slack_webapi_request_error",
    });
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns false for non-transient undici codes that only appear in message text", () => {
    const error = new Error("Request failed with UND_ERR_INVALID_ARG");
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it.each([null, undefined, "string error", 42, { message: "plain object" }])(
    "returns false for non-network input %#",
    (value) => {
      expect(isTransientNetworkError(value)).toBe(false);
    },
  );

  it("returns false for AggregateError with only non-network errors", () => {
    const error = new AggregateError([new Error("regular error")], "Multiple errors");
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns true for undici TLS session null-deref TypeError (Node 18+ message)", () => {
    const err = new TypeError("Cannot read properties of null (reading 'setSession')");
    err.stack = [
      "TypeError: Cannot read properties of null (reading 'setSession')",
      "    at TLSSocket.setSession (node:_tls_wrap:1132:16)",
      "    at Object.connect (node:_tls_wrap:1826:13)",
      "    at Client.connect (undici/lib/core/connect.js:70:20)",
    ].join("\n");
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for undici TLS session null-deref TypeError (Node <18 message)", () => {
    const err = new TypeError("Cannot read property 'setSession' of null");
    err.stack = [
      "TypeError: Cannot read property 'setSession' of null",
      "    at TLSSocket.setSession (node:_tls_wrap:1132:16)",
      "    at Object.connect (node:_tls_wrap:1826:13)",
    ].join("\n");
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns false for unrelated TypeErrors that mention null", () => {
    const err = new TypeError("Cannot read properties of null (reading 'toString')");
    err.stack = [
      "TypeError: Cannot read properties of null (reading 'toString')",
      "    at someAppCode (/app/src/foo.ts:10:5)",
    ].join("\n");
    expect(isTransientNetworkError(err)).toBe(false);
  });
});

describe("isTlsSocketNullDeref", () => {
  it("returns true for Node 18+ TLS setSession null-deref", () => {
    const err = new TypeError("Cannot read properties of null (reading 'setSession')");
    err.stack = [
      "TypeError: Cannot read properties of null (reading 'setSession')",
      "    at TLSSocket.setSession (node:_tls_wrap:1132:16)",
      "    at Object.connect (node:_tls_wrap:1826:13)",
    ].join("\n");
    expect(isTlsSocketNullDeref(err)).toBe(true);
  });

  it("returns true for Node <18 TLS setSession null-deref", () => {
    const err = new TypeError("Cannot read property 'setSession' of null");
    err.stack = [
      "TypeError: Cannot read property 'setSession' of null",
      "    at TLSSocket.setSession (node:_tls_wrap:1132:16)",
    ].join("\n");
    expect(isTlsSocketNullDeref(err)).toBe(true);
  });

  it("returns false when stack has no _tls_wrap or TLSSocket reference", () => {
    const err = new TypeError("Cannot read properties of null (reading 'setSession')");
    err.stack = [
      "TypeError: Cannot read properties of null (reading 'setSession')",
      "    at someApp (/app/src/foo.ts:5:1)",
    ].join("\n");
    expect(isTlsSocketNullDeref(err)).toBe(false);
  });

  it("returns false for non-TypeError errors", () => {
    const err = new Error("Cannot read properties of null (reading 'setSession')");
    (err as unknown as { stack: string }).stack =
      "Error\n    at TLSSocket.setSession (node:_tls_wrap:1132:16)";
    expect(isTlsSocketNullDeref(err)).toBe(false);
  });

  it("returns false for TypeErrors unrelated to setSession", () => {
    const err = new TypeError("Cannot read properties of null (reading 'length')");
    err.stack = "TypeError\n    at TLSSocket.foo (node:_tls_wrap:10:1)";
    expect(isTlsSocketNullDeref(err)).toBe(false);
  });

  it.each([null, undefined, "string", 42])("returns false for non-Error input %#", (value) => {
    expect(isTlsSocketNullDeref(value)).toBe(false);
  });
});
