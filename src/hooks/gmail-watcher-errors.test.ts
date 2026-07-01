// Tests for Gmail watcher error classification.
import { describe, expect, it } from "vitest";
import { isAddressInUseError } from "./gmail-watcher-errors.js";

describe("isAddressInUseError", () => {
  it("detects address already in use", () => {
    expect(isAddressInUseError("address already in use")).toBe(true);
  });

  it("detects EADDRINUSE", () => {
    expect(isAddressInUseError("EADDRINUSE")).toBe(true);
  });

  it("detects eaddrinuse case insensitive", () => {
    expect(isAddressInUseError("eaddrinuse")).toBe(true);
  });

  it("returns false for unrelated error", () => {
    expect(isAddressInUseError("connection refused")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isAddressInUseError("")).toBe(false);
  });

  it("detects address in use in multi-line log", () => {
    expect(isAddressInUseError("Error: listen EADDRINUSE 0.0.0.0:3000")).toBe(true);
  });
});
