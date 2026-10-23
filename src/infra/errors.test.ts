import { expect, it } from "vitest";
import { attachErrorDiagnostic, formatErrorMessageForDisplay } from "./error-diagnostics.js";
import * as errors from "./errors.js";

const token = "sk-abcdefghijklmnopqrstuv";
function expectRedacted(formatted: string, visible: string[], secrets = [token]) {
  visible.forEach((value) => expect(formatted).toContain(value));
  secrets.forEach((value) => expect(formatted).not.toContain(value));
}

it("keeps bounded redacted diagnostics off frozen errors and follows wrapper graphs", () => {
  const error = Object.freeze(new Error("native failure"));
  const before = Object.getOwnPropertyDescriptors(error);
  const diagnostic = `Authorization: Bearer ${token}\n${"x".repeat(4_000)}`;
  expect(attachErrorDiagnostic(error, diagnostic)).toBe(error);
  const wrapper = new AggregateError([{ cause: error }], "outer failure");
  const display = formatErrorMessageForDisplay(wrapper);
  expectRedacted(display, ["Authorization: Bearer"]);
  expect(display.length).toBeLessThanOrEqual('outer failure | {"cause":{}}\n'.length + 2_048);
  expect(errors.formatErrorMessage(wrapper)).toBe('outer failure | {"cause":{}}');
  expect(Object.getOwnPropertyDescriptors(error)).toEqual(before);
  expect(formatErrorMessageForDisplay(new Error("unrelated failure"))).toBe("unrelated failure");
});

it("reads primitive causes and propagates accessor failures", async () => {
  expect(errors.readErrorCause("boom")).toBeUndefined();
  const failure = new Error("cause access failed");
  const error = {
    get cause(): never {
      throw failure;
    },
  };
  expect(() => errors.readErrorCause(error)).toThrow(failure);
  await expect(async () =>
    errors.collectErrorGraphCandidates(error, function* (current) {
      yield errors.readErrorCause(current);
    }),
  ).rejects.toBe(failure);
});

it("matches errno-shaped errors by code", () => {
  const err = Object.assign(new Error("busy"), { code: "EADDRINUSE" });
  expect(errors.isErrno(err)).toBe(true);
  expect(errors.hasErrnoCode(err, "EADDRINUSE")).toBe(true);
  expect(errors.hasErrnoCode(err, "ENOENT")).toBe(false);
  expect(errors.isErrno("busy")).toBe(false);
});

it("does not classify other fs-safe or errno failures as missing paths", () => {
  expect(errors.isMissingPathError({ code: "path-alias" })).toBe(false);
  expect(errors.isMissingPathError(new Error("ENOENT"))).toBe(false);
});

it("redacts sensitive tokens from formatted error messages", () => {
  const formatted = errors.formatErrorMessage(new Error(`Authorization: Bearer ${token}`));
  const codeFormatted = errors.formatErrorMessageWithCode(
    Object.assign(new Error("request failed"), { code: `token=${token}` }),
  );
  expectRedacted(formatted, ["Authorization: Bearer"]);
  expectRedacted(codeFormatted, ["request failed"]);
});

it("redacts HTTP client config secrets from formatted error chains", () => {
  const appSecret = "feishu_app_secret_1234567890";
  const tenantToken = "feishu_tenant_access_abcdef123456";
  const rootCause = new Error(
    `request config: { appSecret: '${appSecret}', headers: { authorization: 'Bearer ${tenantToken}' } }`,
  );
  const httpError = new Error("POST /auth/v3/tenant_access_token failed", { cause: rootCause });
  expectRedacted(
    errors.formatErrorMessage(httpError),
    ["POST /auth/v3/tenant_access_token failed", "appSecret:", "authorization:"],
    [appSecret, tenantToken],
  );
});

it("uses message-only formatting for INVALID_CONFIG and stack formatting otherwise", () => {
  const invalidConfig = Object.assign(new Error(`TOKEN=${token}`), {
    code: "INVALID_CONFIG",
    stack: `Error: TOKEN=${token}\n    at ignored`,
  });
  expect(errors.formatUncaughtError(invalidConfig)).not.toContain("at ignored");

  const uncaught = new Error("boom");
  uncaught.stack = `Error: Authorization: Bearer ${token}\n    at runTask`;
  expectRedacted(errors.formatUncaughtError(uncaught), ["at runTask"]);
});
