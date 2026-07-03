// Tests shared infra error formatting and classification.
import { describe, expect, it } from "vitest";
import {
  collectErrorGraphCandidates,
  detectErrorKind,
  extractErrorCode,
  formatErrorMessage,
  formatUncaughtError,
  hasErrnoCode,
  isErrno,
  readErrorName,
  toErrorObject,
} from "./errors.js";

function createCircularObject() {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  return circular;
}

describe("error helpers", () => {
  it.each([
    { value: { code: "EADDRINUSE" }, expected: "EADDRINUSE" },
    { value: { code: 429 }, expected: "429" },
    { value: { code: false }, expected: undefined },
    { value: "boom", expected: undefined },
  ])("extracts error codes from %j", ({ value, expected }) => {
    expect(extractErrorCode(value)).toBe(expected);
  });

  it.each([
    { value: { name: "AbortError" }, expected: "AbortError" },
    { value: { name: 42 }, expected: "" },
    { value: null, expected: "" },
  ])("reads error names from %j", ({ value, expected }) => {
    expect(readErrorName(value)).toBe(expected);
  });

  it("walks nested error graphs once in breadth-first order", () => {
    const leaf = { name: "leaf" };
    const child = { name: "child" } as {
      name: string;
      cause?: unknown;
      errors?: unknown[];
    };
    const root = { name: "root", cause: child, errors: [leaf, child] };
    child.cause = root;

    expect(
      collectErrorGraphCandidates(root, (current) => [
        current.cause,
        ...((current as { errors?: unknown[] }).errors ?? []),
      ]),
    ).toEqual([root, child, leaf]);
    expect(collectErrorGraphCandidates(null)).toStrictEqual([]);
  });

  it("matches errno-shaped errors by code", () => {
    const err = Object.assign(new Error("busy"), { code: "EADDRINUSE" });
    expect(isErrno(err)).toBe(true);
    expect(hasErrnoCode(err, "EADDRINUSE")).toBe(true);
    expect(hasErrnoCode(err, "ENOENT")).toBe(false);
    expect(isErrno("busy")).toBe(false);
  });

  it.each([
    { value: 123n, expected: "123" },
    { value: false, expected: "false" },
    { value: undefined, expected: "undefined" },
    { value: Symbol("failure"), expected: "Symbol(failure)" },
    { value: createCircularObject(), expected: "[object Object]" },
  ])("formats error messages for case %#", ({ value, expected }) => {
    expect(formatErrorMessage(value)).toBe(expected);
  });

  it("tolerates throwing error accessors", () => {
    const err = new Error("unused");
    let accessorCalls = 0;
    Object.defineProperties(err, {
      message: {
        configurable: true,
        get() {
          accessorCalls += 1;
          throw new Error("message getter must not run");
        },
      },
      cause: {
        configurable: true,
        get() {
          accessorCalls += 1;
          throw new Error("cause getter must not run");
        },
      },
      code: {
        configurable: true,
        get() {
          accessorCalls += 1;
          throw new Error("code getter must not run");
        },
      },
    });

    expect(formatErrorMessage(err)).toBe("Error");
    expect(extractErrorCode(err)).toBeUndefined();
    expect(isErrno(err)).toBe(false);
    expect(hasErrnoCode(err, "EFAIL")).toBe(false);
    expect(accessorCalls).toBe(0);
  });

  it("preserves native DOMException diagnostics", () => {
    const timeoutError = new DOMException("The operation timed out", "TimeoutError");

    expect(readErrorName(timeoutError)).toBe("TimeoutError");
    expect(extractErrorCode(timeoutError)).toBe("23");
    expect(formatErrorMessage(timeoutError)).toBe("The operation timed out");
  });

  it("skips inherited Error subclass accessors", () => {
    let accessorCalls = 0;
    class HostileError extends Error {
      override get name(): string {
        accessorCalls += 1;
        return "HostileError";
      }

      get code(): string {
        accessorCalls += 1;
        return "EHOSTILE";
      }
    }

    const error = new HostileError("dependency failed");
    expect(readErrorName(error)).toBe("Error");
    expect(extractErrorCode(error)).toBeUndefined();
    expect(formatErrorMessage(error)).toBe("dependency failed");
    expect(accessorCalls).toBe(0);
  });

  it("reads Error fallback accessors only when needed", () => {
    let nameAccessorCalls = 0;
    class LazyNameError extends Error {
      override get name(): string {
        nameAccessorCalls += 1;
        return "LazyNameError";
      }
    }

    const error = new LazyNameError("specific message");
    expect(formatErrorMessage(error)).toBe("specific message");
    expect(nameAccessorCalls).toBe(0);
    Object.defineProperty(error, "stack", { configurable: true, value: "specific stack" });
    expect(formatUncaughtError(error)).toBe("specific stack");
    expect(nameAccessorCalls).toBe(0);
  });

  it("traverses .cause chain to include nested error messages", () => {
    const rootCause = new Error("ECONNRESET");
    const httpError = Object.assign(new Error("Network request for 'sendMessage' failed!"), {
      cause: rootCause,
    });
    const formatted = formatErrorMessage(httpError);
    expect(formatted).toContain("Network request for 'sendMessage' failed!");
    expect(formatted).toContain("ECONNRESET");
  });

  it("handles circular .cause references without infinite loop", () => {
    const a: Error & { cause?: unknown } = new Error("error A");
    const b: Error & { cause?: unknown } = new Error("error B");
    a.cause = b;
    b.cause = a;
    const formatted = formatErrorMessage(a);
    expect(formatted).toBe("error A | error B");
  });

  it("dedupes repeated cause messages while preserving deeper distinct causes", () => {
    const rootCause = new Error("provider auth lookup failed");
    const inner = new Error('No API key found for provider "openai".', { cause: rootCause });
    const wrapper = new Error(inner.message, { cause: inner });
    expect(formatErrorMessage(wrapper)).toBe(`${inner.message} | ${rootCause.message}`);
  });

  it("redacts sensitive tokens from formatted error messages", () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    const formatted = formatErrorMessage(new Error(`Authorization: Bearer ${token}`));
    expect(formatted).toContain("Authorization: Bearer");
    expect(formatted).not.toContain(token);
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

  it("coerces unknown values without invoking accessors", () => {
    const errorLike = { code: "EFAIL", message: "Unicode failure: 🦞" };
    Object.defineProperty(errorLike, "status", {
      enumerable: true,
      get() {
        throw new Error("status getter must not run");
      },
    });

    const normalized = toErrorObject(errorLike, "fallback");

    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.message).toBe("Unicode failure: 🦞");
    expect((normalized as Error & { code?: string }).code).toBe("EFAIL");
    expect(Object.hasOwn(normalized, "status")).toBe(false);
    expect(toErrorObject("plain failure", "fallback").message).toBe("plain failure");
  });

  it("keeps Error coercion fields well-formed", () => {
    const normalized = toErrorObject({ message: 42, name: false, stack: null }, "fallback");

    expect(normalized.message).toBe("fallback");
    expect(normalized.name).toBe("Error");
    expect(typeof normalized.stack).toBe("string");
  });

  it.each([
    {
      value: new Error("Unhandled stop reason: refusal_policy"),
      expected: "refusal",
    },
    {
      value: Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
      expected: "timeout",
    },
    {
      value: Object.assign(new Error("Too many requests"), { code: 429 }),
      expected: "rate_limit",
    },
    {
      value: new Error("context_window exceeded with too many tokens"),
      expected: "context_length",
    },
    {
      value: new Error("plain provider failure"),
      expected: undefined,
    },
    {
      value: undefined,
      expected: undefined,
    },
  ] as const)("detects error kind for case %#", ({ value, expected }) => {
    expect(detectErrorKind(value)).toBe(expected);
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
