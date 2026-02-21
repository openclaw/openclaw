import { describe, expect, it } from "vitest";
import { isAbortError, isTransientNetworkError } from "./unhandled-rejections.js";

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

  it("returns true for nested cause chain with network error", () => {
    const innerCause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const outerCause = Object.assign(new Error("wrapper"), { cause: innerCause });
    const error = Object.assign(new TypeError("fetch failed"), { cause: outerCause });
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

  // Slack SDK wrapper pattern tests
  describe("Slack SDK .original wrapper", () => {
    it("returns true for Slack SDK RequestError wrapping ENOTFOUND", () => {
      // This is exactly how @slack/web-api wraps network errors
      const originalError = Object.assign(new Error("getaddrinfo ENOTFOUND slack.com"), {
        code: "ENOTFOUND",
      });
      const slackError = Object.assign(
        new Error("A request error occurred: getaddrinfo ENOTFOUND slack.com"),
        {
          code: "slack_webapi_request_error",
          original: originalError,
        },
      );
      expect(isTransientNetworkError(slackError)).toBe(true);
    });

    it("returns true for Slack SDK RequestError wrapping EAI_AGAIN", () => {
      const originalError = Object.assign(new Error("getaddrinfo EAI_AGAIN slack.com"), {
        code: "EAI_AGAIN",
      });
      const slackError = Object.assign(
        new Error("A request error occurred: getaddrinfo EAI_AGAIN slack.com"),
        {
          code: "slack_webapi_request_error",
          original: originalError,
        },
      );
      expect(isTransientNetworkError(slackError)).toBe(true);
    });

    it("returns true for Slack SDK RequestError wrapping ETIMEDOUT", () => {
      const originalError = Object.assign(new Error("connect ETIMEDOUT"), {
        code: "ETIMEDOUT",
      });
      const slackError = Object.assign(new Error("A request error occurred: connect ETIMEDOUT"), {
        code: "slack_webapi_request_error",
        original: originalError,
      });
      expect(isTransientNetworkError(slackError)).toBe(true);
    });

    it("returns false for Slack SDK error without transient original", () => {
      // Slack platform error (not a network issue)
      const slackError = Object.assign(new Error("An API error occurred: invalid_auth"), {
        code: "slack_webapi_platform_error",
        data: { error: "invalid_auth" },
      });
      expect(isTransientNetworkError(slackError)).toBe(false);
    });

    it("returns false for Slack SDK RequestError with non-network original", () => {
      const originalError = Object.assign(new Error("Some other error"), {
        code: "SOME_OTHER_CODE",
      });
      const slackError = Object.assign(new Error("A request error occurred: Some other error"), {
        code: "slack_webapi_request_error",
        original: originalError,
      });
      expect(isTransientNetworkError(slackError)).toBe(false);
    });
  });
});
