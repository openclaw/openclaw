import { expect, it } from "vitest";
import {
  extractErrorHttpStatus,
  formatProviderRefusalText as formatRefusal,
  formatRawAssistantErrorForUi as formatError,
  formatTransportErrorCopy as transportError,
  isKnownTransportErrorCode,
  parseApiErrorInfo as parseError,
} from "./assistant-error-format.js";

const apiError = (error: unknown, prefix = "") => `${prefix}${JSON.stringify({ error })}`;
const attempt = (status: number, type: string, message: string) => ({
  status,
  details: { error: { type, message } },
});

it("does not treat dns inside a generated path as a network failure", () => {
  const raw =
    "git checkout has no commits: /tmp/openclaw-session-worktree-source-recovery-0Dns0Y/workspace. Create an initial commit, then retry.";
  expect(transportError(raw)).toBeUndefined();
});

it("retains connection guidance without treating DNS as an error code", () => {
  expect(transportError("dns: no response from resolver")).toContain(
    "Couldn't connect to the AI service.",
  );
  expect(isKnownTransportErrorCode("DNS")).toBe(false);
});

it.each([
  ["misalignment", "Chat stopped as a precaution. Review the findings in chat before continuing."],
  ["bio", "The provider refused this request (category: bio). Revise the request and try again."],
])("formats %s refusal guidance", (category, expected) => {
  const diagnostics = [{ type: "provider_refusal", details: { category } }];
  expect(formatRefusal({ diagnostics })).toBe(expected);
});

it("extracts guarded upstream status", () => {
  expect(extractErrorHttpStatus("unexpected status 503 from upstream")?.code).toBe(503);
});

it.each([
  [{ error: "missing model" }, { message: "missing model", type: undefined }],
  [
    { error: "invalid_client", message: "Sign in again" },
    { message: "Sign in again", type: "invalid_client" },
  ],
])("distinguishes string error messages from codes: %j", (payload, expected) => {
  expect(parseError(JSON.stringify(payload))).toMatchObject(expected);
});

it("preserves distinct validation type and code after HTTP 502", () => {
  const error = {
    type: "invalid_request_error",
    code: "unknown_parameter",
    message: "Unsupported parameter: timeout",
  };
  expect(parseError(apiError(error, "HTTP 502: "))).toMatchObject(error);
});

it("extracts the final upstream rejection from a proxy failure envelope", () => {
  const error = {
    type: "invalid_request_error",
    message: "A maximum of 4 blocks with cache_control may be provided. Found 5.",
  };
  const attempts = [attempt(503, "api_error", "Unavailable"), { status: 400, details: { error } }];
  const raw = apiError({ message: "All target providers failed.", attempts }, "400: ");
  expect(parseError(raw)).toMatchObject({ httpCode: "400", ...error });
});

it("does not return raw HTML after an HTTP reason phrase", () => {
  const raw = "HTTP 502 Bad Gateway\n\n<!doctype html><html><body><h1>502</h1></body></html>";
  expect(formatError(raw)).toBe(
    "Couldn't reach the AI service. Try again in a moment. If it continues, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
  );
});

it.each([
  ["100 Continue", "HTTP 100: Continue"],
  ["599 Provider Error", "HTTP 599: Provider Error"],
  ["000 Invalid", "000 Invalid"],
  ["600 Invalid", "600 Invalid"],
  ["999 Invalid", "999 Invalid"],
])("formats only status lines inside the HTTP range: %s", (raw, expected) => {
  expect(formatError(raw)).toBe(expected);
});

it("does not attach invalid status prefixes to API payloads", () => {
  const error = { type: "server_error", message: "Provider failed." };
  const payload = JSON.stringify({ type: "error", error });
  expect(parseError(`599 ${payload}`)).toMatchObject({ httpCode: "599", ...error });
  expect(formatError(`599 ${payload}`)).toBe("HTTP 599 server_error: Provider failed.");
  for (const code of ["000", "600", "999"]) {
    expect(parseError(`${code} ${payload}`)).toBeNull();
    expect(formatError(`${code} ${payload}`)).toBe(`${code} ${payload}`);
  }
});
