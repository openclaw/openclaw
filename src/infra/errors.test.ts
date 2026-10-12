// Tests shared infra error formatting helpers.
import { describe, expect, it } from "vitest";
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

describe("error helpers", () => {
  it("keeps bounded redacted diagnostics off frozen errors and follows wrapper graphs", () => {
    const error = Object.freeze(new Error("native failure"));
    const secret = "sk-abcdefghijklmnopqrstuv";
    const before = Object.getOwnPropertyDescriptors(error);
    expect(
      attachErrorDiagnostic(error, `Authorization: Bearer ${secret}\n${"x".repeat(4_000)}`),
    ).toBe(error);
    const wrapper = new AggregateError([{ cause: error }], "outer failure");
    const display = formatErrorMessageForDisplay(wrapper);
    expect(display).toContain("Authorization: Bearer");
    expect(display).not.toContain(secret);
    expect(display.length).toBeLessThanOrEqual('outer failure | {"cause":{}}\n'.length + 2_048);
    expect(formatErrorMessage(wrapper)).toBe('outer failure | {"cause":{}}');
    expect(Object.getOwnPropertyDescriptors(error)).toEqual(before);
    expect(formatErrorMessageForDisplay(new Error("unrelated failure"))).toBe("unrelated failure");
  });

  it.each([["primitive input", "boom", undefined]])(
    "reads %s directly",
    (_name, value, expected) => {
      expect(readErrorCause(value)).toBe(expected);
    },
  );

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
    expect(formatted).toContain("Authorization: Bearer");
    expect(formatted).not.toContain(token);
    expect(codeFormatted).toContain("request failed");
    expect(codeFormatted).not.toContain(token);
  });

  it("redacts HTTP client config secrets from formatted error chains", () => {
    const appSecret = "feishu_app_secret_1234567890";
    const tenantToken = "feishu_tenant_access_abcdef123456";
    const rootCause = new Error(
      `request config: { appSecret: '${appSecret}', headers: { authorization: 'Bearer ${tenantToken}' } }`,
    );
    const httpError = Object.assign(new Error(`POST /auth/v3/tenant_access_token failed`), {
      cause: rootCause,
    });

    const formatted = formatErrorMessage(httpError);

    expect(formatted).toContain("POST /auth/v3/tenant_access_token failed");
    expect(formatted).toContain("appSecret:");
    expect(formatted).toContain("authorization:");
    expect(formatted).not.toContain(appSecret);
    expect(formatted).not.toContain(tenantToken);
  });

  it("uses message-only formatting for INVALID_CONFIG and stack formatting otherwise", () => {
    const invalidConfig = Object.assign(new Error("TOKEN=sk-abcdefghijklmnopqrstuv"), {
      code: "INVALID_CONFIG",
      stack: "Error: TOKEN=sk-abcdefghijklmnopqrstuv\n    at ignored",
    });
    expect(formatUncaughtError(invalidConfig)).not.toContain("at ignored");

    const uncaught = new Error("boom");
    uncaught.stack = "Error: Authorization: Bearer sk-abcdefghijklmnopqrstuv\n    at runTask";
    const formatted = formatUncaughtError(uncaught);
    expect(formatted).toContain("at runTask");
    expect(formatted).not.toContain("sk-abcdefghijklmnopqrstuv");
  });
});
