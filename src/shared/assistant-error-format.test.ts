import { describe, expect, it } from "vitest";
import {
  extractErrorHttpStatus,
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

  it("retains connection guidance without treating DNS as an error code", () => {
    expect(formatTransportErrorCopy("dns: no response from resolver")).toContain(
      "Couldn't connect to the AI service.",
    );
    expect(isKnownTransportErrorCode("DNS")).toBe(false);
  });
});

describe("formatProviderRefusalText", () => {
  it.each([
    [
      "misalignment",
      "Chat stopped as a precaution. Review the findings in chat before continuing.",
    ],
    ["bio", "The provider refused this request (category: bio). Revise the request and try again."],
  ])("formats %s refusal guidance", (category, expected) => {
    expect(
      formatProviderRefusalText({
        diagnostics: [{ type: "provider_refusal", details: { category } }],
      }),
    ).toBe(expected);
  });
});

describe("extractErrorHttpStatus", () => {
  it("extracts guarded upstream status", () => {
    expect(extractErrorHttpStatus("unexpected status 503 from upstream")?.code).toBe(503);
  });
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

  it("preserves distinct validation type and code after HTTP 502", () => {
    const error = {
      type: "invalid_request_error",
      code: "unknown_parameter",
      message: "Unsupported parameter: timeout",
    };
    expect(parseApiErrorInfo(`HTTP 502: ${JSON.stringify({ error })}`)).toMatchObject(error);
  });

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
    const raw = "HTTP 502 Bad Gateway\n\n<!doctype html><html><body><h1>502</h1></body></html>";

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
