import { describe, expect, it } from "vitest";
import { SafeRelativeModulePathSchema } from "./zod-schema.hooks.js";

describe("SafeRelativeModulePathSchema", () => {
  // Test the fix for #42363 - non-string values should be rejected, not crash

  it("accepts valid relative module paths", () => {
    expect(() => SafeRelativeModulePathSchema.parse("./hooks/my-hook.ts")).not.toThrow();
    expect(() => SafeRelativeModulePathSchema.parse("../shared/hook.js")).not.toThrow();
    expect(() => SafeRelativeModulePathSchema.parse("relative/path.js")).not.toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => SafeRelativeModulePathSchema.parse("/absolute/path.js")).toThrow();
    expect(() => SafeRelativeModulePathSchema.parse("C:\\absolute\\path.js")).toThrow();
  });

  it("rejects path traversal", () => {
    expect(() => SafeRelativeModulePathSchema.parse("../etc/passwd")).toThrow();
    expect(() => SafeRelativeModulePathSchema.parse("foo/../../../bar.js")).toThrow();
  });

  it("rejects tilde paths", () => {
    expect(() => SafeRelativeModulePathSchema.parse("~/hooks/my-hook.js")).toThrow();
  });

  it("rejects URL-like paths", () => {
    expect(() => SafeRelativeModulePathSchema.parse("file:///etc/passwd")).toThrow();
    expect(() => SafeRelativeModulePathSchema.parse("http://example.com/hook.js")).toThrow();
  });

  // These are the key tests for the bug fix #42363
  // Previously, non-string values would cause TypeError: value.includes is not a function

  it("rejects null value without crashing", () => {
    expect(() => SafeRelativeModulePathSchema.parse(null)).toThrow();
  });

  it("rejects undefined value without crashing", () => {
    expect(() => SafeRelativeModulePathSchema.parse(undefined)).toThrow();
  });

  it("rejects number value without crashing", () => {
    expect(() => SafeRelativeModulePathSchema.parse(123)).toThrow();
    expect(() => SafeRelativeModulePathSchema.parse(0)).toThrow();
    expect(() => SafeRelativeModulePathSchema.parse(-1)).toThrow();
  });

  it("rejects boolean value without crashing", () => {
    expect(() => SafeRelativeModulePathSchema.parse(true)).toThrow();
    expect(() => SafeRelativeModulePathSchema.parse(false)).toThrow();
  });

  it("rejects object value without crashing", () => {
    expect(() => SafeRelativeModulePathSchema.parse({})).toThrow();
    expect(() => SafeRelativeModulePathSchema.parse({ path: "./hook.js" })).toThrow();
  });

  it("rejects array value without crashing", () => {
    expect(() => SafeRelativeModulePathSchema.parse(["./hook.js"])).toThrow();
    expect(() => SafeRelativeModulePathSchema.parse([])).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => SafeRelativeModulePathSchema.parse("")).toThrow();
  });

  it("rejects whitespace-only string", () => {
    expect(() => SafeRelativeModulePathSchema.parse("   ")).toThrow();
  });
});
