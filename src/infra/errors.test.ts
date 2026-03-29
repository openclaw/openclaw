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
    expect(collectErrorGraphCandidates(null)).toEqual([]);
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
    { value: createCircularObject(), expected: "[object Object]" },
  ])("formats error messages for case %#", ({ value, expected }) => {
    expect(formatErrorMessage(value)).toBe(expected);
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
