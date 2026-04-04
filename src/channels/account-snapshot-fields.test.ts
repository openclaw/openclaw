import { describe, expect, it } from "vitest";
import {
  resolveConfiguredFromCredentialStatuses,
  hasConfiguredUnavailableCredentialStatus,
  hasResolvedCredentialValue,
} from "./account-snapshot-fields.js";

describe("resolveConfiguredFromCredentialStatuses", () => {
  it("returns undefined for null/undefined account", () => {
    expect(resolveConfiguredFromCredentialStatuses(null)).toBeUndefined();
    expect(resolveConfiguredFromCredentialStatuses(undefined)).toBeUndefined();
  });

  it("returns undefined for non-object account", () => {
    expect(resolveConfiguredFromCredentialStatuses("string" as any)).toBeUndefined();
    expect(resolveConfiguredFromCredentialStatuses([] as any)).toBeUndefined();
  });

  it("returns true when any credential is available", () => {
    expect(resolveConfiguredFromCredentialStatuses({ tokenStatus: "available" })).toBe(true);
  });

  it("returns false when any credential is missing", () => {
    expect(resolveConfiguredFromCredentialStatuses({ tokenStatus: "missing" })).toBe(false);
  });

  it("returns true when credential is configured_unavailable", () => {
    expect(resolveConfiguredFromCredentialStatuses({ tokenStatus: "configured_unavailable" })).toBe(true);
  });

  it("returns undefined when no credential status present", () => {
    expect(resolveConfiguredFromCredentialStatuses({ name: "test" })).toBeUndefined();
  });
});

describe("hasConfiguredUnavailableCredentialStatus", () => {
  it("returns true when configured_unavailable found", () => {
    expect(hasConfiguredUnavailableCredentialStatus({ tokenStatus: "configured_unavailable" })).toBe(true);
  });

  it("returns false for available", () => {
    expect(hasConfiguredUnavailableCredentialStatus({ tokenStatus: "available" })).toBe(false);
  });

  it("returns false for missing", () => {
    expect(hasConfiguredUnavailableCredentialStatus({ tokenStatus: "missing" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(hasConfiguredUnavailableCredentialStatus(null)).toBe(false);
  });
});

describe("hasResolvedCredentialValue", () => {
  it("returns true when token is present", () => {
    expect(hasResolvedCredentialValue({ token: "sk-..." })).toBe(true);
  });

  it("returns true when tokenStatus is available", () => {
    expect(hasResolvedCredentialValue({ tokenStatus: "available" })).toBe(true);
  });

  it("returns false for empty token", () => {
    expect(hasResolvedCredentialValue({ token: "   " })).toBe(false);
  });

  it("returns false for missing", () => {
    expect(hasResolvedCredentialValue({})).toBe(false);
  });
});
