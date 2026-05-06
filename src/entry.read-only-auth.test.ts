import { afterEach, describe, expect, it } from "vitest";
import { shouldForceReadOnlyAuthStore } from "./entry.js";

describe("shouldForceReadOnlyAuthStore", () => {
  it("returns true for a direct `secrets audit` invocation", () => {
    expect(shouldForceReadOnlyAuthStore(["node", "openclaw", "secrets", "audit"])).toBe(true);
  });

  it("returns true when an option separates the parent and the leaf", () => {
    expect(shouldForceReadOnlyAuthStore(["node", "openclaw", "secrets", "--json", "audit"])).toBe(
      true,
    );
  });

  it("returns true when trailing options follow the command path", () => {
    expect(shouldForceReadOnlyAuthStore(["node", "openclaw", "secrets", "audit", "--check"])).toBe(
      true,
    );
  });

  it("returns true when leading options precede the command path", () => {
    expect(
      shouldForceReadOnlyAuthStore(["node", "openclaw", "--no-color", "secrets", "audit"]),
    ).toBe(true);
  });

  it("returns false for a sibling command under the same parent", () => {
    expect(shouldForceReadOnlyAuthStore(["node", "openclaw", "secrets", "list"])).toBe(false);
  });

  it("returns false for the parent alone", () => {
    expect(shouldForceReadOnlyAuthStore(["node", "openclaw", "secrets"])).toBe(false);
  });

  it("returns false for the leaf alone (wrong parent scope)", () => {
    expect(shouldForceReadOnlyAuthStore(["node", "openclaw", "audit"])).toBe(false);
  });

  it("returns false for an empty invocation", () => {
    expect(shouldForceReadOnlyAuthStore([])).toBe(false);
    expect(shouldForceReadOnlyAuthStore(["node", "openclaw"])).toBe(false);
  });

  it("returns false when the two tokens appear in reversed order", () => {
    expect(shouldForceReadOnlyAuthStore(["node", "openclaw", "audit", "secrets"])).toBe(false);
  });
});

describe("OPENCLAW_AUTH_STORE_READONLY integration with the gate", () => {
  const originalArgv = process.argv;
  const originalEnv = process.env.OPENCLAW_AUTH_STORE_READONLY;

  afterEach(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_AUTH_STORE_READONLY;
    } else {
      process.env.OPENCLAW_AUTH_STORE_READONLY = originalEnv;
    }
  });

  it("sets the env to '1' when the gate matches production argv", () => {
    process.argv = ["node", "openclaw", "secrets", "audit"];
    delete process.env.OPENCLAW_AUTH_STORE_READONLY;
    if (shouldForceReadOnlyAuthStore(process.argv)) {
      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
    }
    expect(process.env.OPENCLAW_AUTH_STORE_READONLY).toBe("1");
  });

  it("leaves the env unset when the gate does not match", () => {
    process.argv = ["node", "openclaw", "secrets", "list"];
    delete process.env.OPENCLAW_AUTH_STORE_READONLY;
    if (shouldForceReadOnlyAuthStore(process.argv)) {
      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
    }
    expect(process.env.OPENCLAW_AUTH_STORE_READONLY).toBeUndefined();
  });
});
