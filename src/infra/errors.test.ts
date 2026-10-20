import { expect, it } from "vitest";
import { attachErrorDiagnostic, formatErrorMessageForDisplay } from "./error-diagnostics.js";
import {
  collectErrorGraphCandidates,
  formatErrorMessage,
  formatErrorMessageWithCode,
  formatUncaughtError,
  hasErrnoCode,
  isErrno,
  isMissingPathError,
  readErrorCause,
} from "./errors.js";

function expectRedacted(formatted: string, visible: string[], secrets: string[]) {
  for (const value of visible) {
    expect(formatted).toContain(value);
  }
  for (const value of secrets) {
    expect(formatted).not.toContain(value);
  }
}

it("keeps bounded redacted diagnostics off frozen errors and follows wrapper graphs", () => {
  const error = Object.freeze(new Error("native failure"));
  const secret = "sk-abcdefghijklmnopqrstuv";
  const before = Object.getOwnPropertyDescriptors(error);
  expect(
    attachErrorDiagnostic(error, `Authorization: Bearer ${secret}\n${"x".repeat(4_000)}`),
  ).toBe(error);
  const wrapper = new AggregateError([{ cause: error }], "outer failure");
  const display = formatErrorMessageForDisplay(wrapper);
  expectRedacted(display, ["Authorization: Bearer"], [secret]);
  expect(display.length).toBeLessThanOrEqual('outer failure | {"cause":{}}\n'.length + 2_048);
  expect(formatErrorMessage(wrapper)).toBe('outer failure | {"cause":{}}');
  expect(Object.getOwnPropertyDescriptors(error)).toEqual(before);
  expect(formatErrorMessageForDisplay(new Error("unrelated failure"))).toBe("unrelated failure");
});

it("reads primitive input directly", () => {
  expect(readErrorCause("boom")).toBeUndefined();
});

it("propagates cause accessor failures", () => {
  const failure = new Error("cause access failed");
  const error = {
    get cause(): never {
      throw failure;
    },
  };
  expect(() => readErrorCause(error)).toThrow(failure);
  let caught: unknown;
  try {
    collectErrorGraphCandidates(error, function* (current) {
      yield readErrorCause(current);
    });
  } catch (caughtError) {
    caught = caughtError;
  }
  expect(caught).toBe(failure);
});

it("matches errno-shaped errors by code", () => {
  const err = Object.assign(new Error("busy"), { code: "EADDRINUSE" });
  expect(isErrno(err)).toBe(true);
  expect(hasErrnoCode(err, "EADDRINUSE")).toBe(true);
  expect(hasErrnoCode(err, "ENOENT")).toBe(false);
  expect(isErrno("busy")).toBe(false);
});

it("does not classify other fs-safe or errno failures as missing paths", () => {
  expect(isMissingPathError({ code: "path-alias" })).toBe(false);
  expect(isMissingPathError(new Error("ENOENT"))).toBe(false);
});

it("redacts sensitive tokens from formatted error messages", () => {
  const token = "sk-abcdefghijklmnopqrstuv";
  const formatted = formatErrorMessage(new Error(`Authorization: Bearer ${token}`));
  const codeFormatted = formatErrorMessageWithCode(
    Object.assign(new Error("request failed"), { code: `token=${token}` }),
  );
  expectRedacted(formatted, ["Authorization: Bearer"], [token]);
  expectRedacted(codeFormatted, ["request failed"], [token]);
});

it("redacts HTTP client config secrets from formatted error chains", () => {
  const appSecret = "feishu_app_secret_1234567890";
  const tenantToken = "feishu_tenant_access_abcdef123456";
  const rootCause = new Error(
    `request config: { appSecret: '${appSecret}', headers: { authorization: 'Bearer ${tenantToken}' } }`,
  );
  const httpError = new Error("POST /auth/v3/tenant_access_token failed", { cause: rootCause });
  expectRedacted(
    formatErrorMessage(httpError),
    ["POST /auth/v3/tenant_access_token failed", "appSecret:", "authorization:"],
    [appSecret, tenantToken],
  );
});

it("uses message-only formatting for INVALID_CONFIG and stack formatting otherwise", () => {
  const invalidConfig = Object.assign(new Error("TOKEN=sk-abcdefghijklmnopqrstuv"), {
    code: "INVALID_CONFIG",
    stack: "Error: TOKEN=sk-abcdefghijklmnopqrstuv\n    at ignored",
  });
  expect(formatUncaughtError(invalidConfig)).not.toContain("at ignored");

  const uncaught = new Error("boom");
  uncaught.stack = "Error: Authorization: Bearer sk-abcdefghijklmnopqrstuv\n    at runTask";
  expectRedacted(formatUncaughtError(uncaught), ["at runTask"], ["sk-abcdefghijklmnopqrstuv"]);
});
