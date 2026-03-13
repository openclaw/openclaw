import { describe, expect, it } from "vitest";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  formatUncaughtError,
  hasErrnoCode,
  isErrno,
  readErrorName,
} from "./errors.js";

describe("error helpers", () => {
  it("extracts codes and names from string and numeric error metadata", () => {
    expect(extractErrorCode({ code: "EADDRINUSE" })).toBe("EADDRINUSE");
    expect(extractErrorCode({ code: 429 })).toBe("429");
    expect(extractErrorCode({ code: false })).toBeUndefined();
    expect(extractErrorCode("boom")).toBeUndefined();

    expect(readErrorName({ name: "AbortError" })).toBe("AbortError");
    expect(readErrorName({ name: 42 })).toBe("");
    expect(readErrorName(null)).toBe("");
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
      collectErrorGraphCandidates(root, (current) => [current.cause, ...(current.errors ?? [])]),
    ).toEqual([root, child, leaf]);
    expect(collectErrorGraphCandidates(null)).toEqual([]);
  });

  it("matches errno-shaped errors by code", () => {
    const err = Object.assign(new Error("busy"), { code: "EADDRINUSE" });
    expect(isErrno(err)).toBe(true);
    expect(hasErrnoCode(err, "EADDRINUSE")).toBe(true);
    expect(hasErrnoCode(err, "ENOENT")).toBe(false);
    expect(isErrno("busy")).toBe(false);
  });

  it("formats primitives and circular objects without throwing", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(formatErrorMessage(123n)).toBe("123");
    expect(formatErrorMessage(false)).toBe("false");
    expect(formatErrorMessage(circular)).toBe("[object Object]");
  });

  it("redacts sensitive tokens from formatted error messages", () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    const formatted = formatErrorMessage(new Error(`Authorization: Bearer ${token}`));
    expect(formatted).toContain("Authorization: Bearer");
    expect(formatted).not.toContain(token);
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
