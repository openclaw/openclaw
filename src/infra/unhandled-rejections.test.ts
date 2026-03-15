import { describe, expect, it } from "vitest";
import {
  isAbortError,
  isPlaywrightWorkerTargetAssertion,
  isTransientNetworkError,
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
      "EPROTO",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "ERR_SSL_PROTOCOL_RETURNED_AN_ERROR",
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

  it("returns true for wrapped fetch-failed messages from integration clients", () => {
    const error = new Error("Failed to get gateway information from Discord: fetch failed");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for wrapped Discord upstream-connect parse failures", () => {
    const error = new Error(
      `Failed to get gateway information from Discord: Unexpected token 'u', "upstream connect error or disconnect/reset before headers. reset reason: overflow" is not valid JSON`,
    );
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns false for non-network fetch-failed wrappers from tools", () => {
    const error = new Error("Web fetch failed (404): Not Found");
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns true for TLS/SSL transient message snippets", () => {
    expect(isTransientNetworkError(new Error("write EPROTO 00A8B0C9:error"))).toBe(true);
    expect(
      isTransientNetworkError(
        new Error("SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER while connecting"),
      ),
    ).toBe(true);
    expect(isTransientNetworkError(new Error("tlsv1 alert protocol version"))).toBe(true);
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
});

describe("isPlaywrightWorkerTargetAssertion", () => {
  it("returns true for shared_worker assertion with targetInfo in message", () => {
    const error = new Error(
      'targetInfo: {"type":"shared_worker","url":"https://www.facebook.com/sw.js"}',
    );
    error.stack = `Error: targetInfo: ...
    at assert (playwright-core/lib/utils/isomorphic/assert.js:1:1)
    at CRBrowser._onAttachedToTarget (playwright-core/lib/server/chromium/crBrowser.js:147:5)`;
    expect(isPlaywrightWorkerTargetAssertion(error)).toBe(true);
  });

  it("returns true for service_worker assertion with targetInfo in message", () => {
    const error = new Error('targetInfo: {"type":"service_worker","url":"https://x.com/sw.js"}');
    error.stack = `Error: targetInfo: ...
    at assert (playwright-core/lib/utils/isomorphic/assert.js:1:1)
    at CRBrowser._onAttachedToTarget (playwright-core/lib/server/chromium/crBrowser.js:147:5)`;
    expect(isPlaywrightWorkerTargetAssertion(error)).toBe(true);
  });

  it("returns true when message has worker type and Playwright stack (no targetInfo keyword)", () => {
    const error = new Error('unexpected target type: "shared_worker"');
    error.stack = `Error: unexpected target type
    at CRBrowser._onAttachedToTarget (crBrowser.js:147:5)`;
    expect(isPlaywrightWorkerTargetAssertion(error)).toBe(true);
  });

  it("returns true when message has worker type and crBrowser in stack", () => {
    const error = new Error("unexpected type shared_worker");
    error.stack = `Error: unexpected
    at Object.crBrowser (lib/server/chromium/crBrowser.js:150:3)`;
    expect(isPlaywrightWorkerTargetAssertion(error)).toBe(true);
  });

  it("returns false for regular errors", () => {
    expect(isPlaywrightWorkerTargetAssertion(new Error("Something went wrong"))).toBe(false);
  });

  it("returns false for errors with worker type but no Playwright context", () => {
    const error = new Error("shared_worker failed to load");
    expect(isPlaywrightWorkerTargetAssertion(error)).toBe(false);
  });

  it("returns false when targetInfo is in message but no Playwright stack frames are present", () => {
    const error = new Error('targetInfo: {"type":"shared_worker"} failed in custom CDP handler');
    error.stack = "Error: targetInfo ...\n    at customCDP.handleTarget (custom-cdp.js:10:1)";
    expect(isPlaywrightWorkerTargetAssertion(error)).toBe(false);
  });

  it("returns false for Playwright errors without worker types", () => {
    const error = new Error('targetInfo: {"type":"page","url":"https://example.com"}');
    error.stack = `Error: targetInfo: ...
    at CRBrowser._onAttachedToTarget (crBrowser.js:147:5)`;
    expect(isPlaywrightWorkerTargetAssertion(error)).toBe(false);
  });

  it.each([null, undefined, "string error", 42, { message: "plain object" }])(
    "returns false for non-error input %#",
    (value) => {
      expect(isPlaywrightWorkerTargetAssertion(value)).toBe(false);
    },
  );
});
