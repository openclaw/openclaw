import { describe, expect, it } from "vitest";
import {
  extractErrorHttpStatus,
  extractLeadingHttpStatus,
  extractProviderWrappedHttpStatus,
  formatProviderRefusalText,
  formatRawAssistantErrorForUi,
  formatTransportErrorCopy,
  isKnownTransportErrorCode,
  parseApiErrorInfo,
} from "./assistant-error-format.js";

describe("formatTransportErrorCopy", () => {
  it("does not treat dns inside a generated path as a network failure", () => {
    expect(
      formatTransportErrorCopy(
        "git checkout has no commits: /tmp/openclaw-session-worktree-source-recovery-0Dns0Y/workspace. Create an initial commit, then retry.",
      ),
    ).toBeUndefined();
  });

  it.each(["DNS lookup failed", "dns: no response from resolver"])(
    "retains connection guidance for %s without treating DNS as an error code",
    (message) => {
      expect(formatTransportErrorCopy(message)).toContain("Couldn't connect to the AI service.");
      expect(isKnownTransportErrorCode("DNS")).toBe(false);
    },
  );
});

describe("formatProviderRefusalText", () => {
  it("directs a misalignment stop to review instead of another ordinary retry", () => {
    expect(
      formatProviderRefusalText({
        diagnostics: [{ type: "provider_refusal", details: { category: "misalignment" } }],
      }),
    ).toBe("Chat stopped as a precaution. Review the findings in chat before continuing.");
  });
  it("formats a sanitized refusal category", () => {
    expect(
      formatProviderRefusalText({
        diagnostics: [{ type: "provider_refusal", details: { category: "bio" } }],
      }),
    ).toBe("The provider refused this request (category: bio). Revise the request and try again.");
  });
});

describe("extractLeadingHttpStatus", () => {
  it("accepts status codes in the valid HTTP range 100-599", () => {
    expect(extractLeadingHttpStatus("100 everything is fine")).toEqual({
      code: 100,
      rest: "everything is fine",
    });
    expect(extractLeadingHttpStatus("500 internal error")).toEqual({
      code: 500,
      rest: "internal error",
    });
    expect(extractLeadingHttpStatus("599 something rest")).toEqual({
      code: 599,
      rest: "something rest",
    });
  });

  it("rejects 3-digit sequences outside the HTTP status code range", () => {
    // 000 / 099 / 999 / 600 — the regex would capture these as 3-digit
    // numbers, but they are not valid HTTP statuses and should not be
    // surfaced as "HTTP <code>" in user-visible messages or in retry
    // classification.
    expect(extractLeadingHttpStatus("000 something")).toBeNull();
    expect(extractLeadingHttpStatus("099 something")).toBeNull();
    expect(extractLeadingHttpStatus("600 something")).toBeNull();
    expect(extractLeadingHttpStatus("999 something")).toBeNull();
  });

  it("rejects strings that do not start with a 3-digit HTTP status", () => {
    expect(extractLeadingHttpStatus("no status here")).toBeNull();
    expect(extractLeadingHttpStatus("")).toBeNull();
  });
});

describe("extractProviderWrappedHttpStatus", () => {
  it("accepts provider-wrapped statuses inside the valid HTTP range", () => {
    expect(extractProviderWrappedHttpStatus("OpenAI API error (503): service down")).toEqual({
      code: 503,
      rest: "service down",
    });
    expect(extractProviderWrappedHttpStatus("API error (429): rate limited")).toEqual({
      code: 429,
      rest: "rate limited",
    });
  });

  it("rejects provider-wrapped statuses outside the valid HTTP range", () => {
    expect(extractProviderWrappedHttpStatus("API error (000): something")).toBeNull();
    expect(extractProviderWrappedHttpStatus("API error (999): something")).toBeNull();
    expect(extractProviderWrappedHttpStatus("API error (600): something")).toBeNull();
  });
});

describe("extractErrorHttpStatus", () => {
  it.each([
    ["HTTP 429 too many requests", 429],
    ["OpenAI API error (500): upstream failed", 500],
    ["error, status code: 400, message: invalid request", 400],
    ["unexpected status 503 from upstream", 503],
    ["Error: HTTP status: 504, gateway timeout", 504],
  ])("extracts guarded status from %s", (message, code) => {
    expect(extractErrorHttpStatus(message)?.code).toBe(code);
  });

  it.each(["request id req-4291 failed", "model model-x-500-preview not found"])(
    "rejects embedded numeric text: %s",
    (message) => {
      expect(extractErrorHttpStatus(message)).toBeNull();
    },
  );
});

describe("HTTP status consumers", () => {
  it.each([
    [{ error: "missing model" }, { message: "missing model", type: undefined }],
    [
      { error: "invalid_client", message: "Sign in again" },
      { message: "Sign in again", type: "invalid_client" },
    ],
  ])("distinguishes string error messages from codes: %j", (payload, expected) => {
    expect(parseApiErrorInfo(JSON.stringify(payload))).toMatchObject(expected);
  });

  it.each(["", "error: ", "500 ", "500: ", "HTTP 502: "])(
    "preserves distinct validation type and code after %s",
    (prefix) => {
      const error = {
        type: "invalid_request_error",
        code: "unknown_parameter",
        message: "Unsupported parameter: timeout",
      };
      expect(parseApiErrorInfo(`${prefix}${JSON.stringify({ error })}`)).toMatchObject(error);
    },
  );

  it("extracts the final upstream rejection from a proxy failure envelope", () => {
    const message = "A maximum of 4 blocks with cache_control may be provided. Found 5.";
    const raw = `400: ${JSON.stringify({
      error: {
        message: "All target providers failed.",
        attempts: [
          { status: 503, details: { error: { type: "api_error", message: "Unavailable" } } },
          { status: 400, details: { error: { type: "invalid_request_error", message } } },
        ],
      },
    })}`;
    expect(parseApiErrorInfo(raw)).toMatchObject({
      httpCode: "400",
      type: "invalid_request_error",
      message,
    });
  });

  it("does not return raw HTML after an HTTP reason phrase", () => {
    const raw = [
      "HTTP 502 Bad Gateway",
      "",
      "<!doctype html><html><body><h1>502</h1></body></html>",
    ].join("\n");

    expect(formatRawAssistantErrorForUi(raw)).toBe(
      "Couldn't reach the AI service. Try again in a moment. If it continues, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    );
  });

  it("formats only status lines inside the HTTP range", () => {
    expect(formatRawAssistantErrorForUi("100 Continue")).toBe("HTTP 100: Continue");
    expect(formatRawAssistantErrorForUi("599 Provider Error")).toBe("HTTP 599: Provider Error");
    expect(formatRawAssistantErrorForUi("000 Invalid")).toBe("000 Invalid");
    expect(formatRawAssistantErrorForUi("600 Invalid")).toBe("600 Invalid");
    expect(formatRawAssistantErrorForUi("999 Invalid")).toBe("999 Invalid");
  });

  it("does not attach invalid status prefixes to API payloads", () => {
    const payload = '{"type":"error","error":{"type":"server_error","message":"Provider failed."}}';

    expect(parseApiErrorInfo(`599 ${payload}`)).toMatchObject({
      httpCode: "599",
      type: "server_error",
      message: "Provider failed.",
    });
    expect(formatRawAssistantErrorForUi(`599 ${payload}`)).toBe(
      "HTTP 599 server_error: Provider failed.",
    );

    for (const code of ["000", "600", "999"]) {
      expect(parseApiErrorInfo(`${code} ${payload}`)).toBeNull();
      expect(formatRawAssistantErrorForUi(`${code} ${payload}`)).toBe(`${code} ${payload}`);
    }
  });
});
