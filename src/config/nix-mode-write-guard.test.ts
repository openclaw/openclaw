import { describe, expect, it } from "vitest";
import {
  assertConfigWriteAllowedInCurrentMode,
  formatNixModeConfigMutationMessage,
  NixModeConfigMutationError,
} from "./nix-mode-write-guard.js";

describe("nix-mode-write-guard", () => {
  it("throws NixModeConfigMutationError when NIX_MODE=1 and no skip flag", () => {
    expect(() =>
      assertConfigWriteAllowedInCurrentMode({
        env: { OPENCLAW_NIX_MODE: "1" },
        operation: "doctor --fix",
      }),
    ).toThrow(NixModeConfigMutationError);
  });

  it("does not throw when skipIfNoConfigMutation is true in Nix mode", () => {
    expect(() =>
      assertConfigWriteAllowedInCurrentMode({
        env: { OPENCLAW_NIX_MODE: "1" },
        operation: "models auth login",
        skipIfNoConfigMutation: true,
      }),
    ).not.toThrow();
  });

  it("still throws in Nix mode when skipIfNoConfigMutation is false", () => {
    expect(() =>
      assertConfigWriteAllowedInCurrentMode({
        env: { OPENCLAW_NIX_MODE: "1" },
        operation: "config set",
        skipIfNoConfigMutation: false,
      }),
    ).toThrow(NixModeConfigMutationError);
  });

  it("is a no-op when OPENCLAW_NIX_MODE is not set", () => {
    expect(() =>
      assertConfigWriteAllowedInCurrentMode({
        env: {},
        operation: "config set",
      }),
    ).not.toThrow();
  });

  it("includes the operation name in the error message", () => {
    const message = formatNixModeConfigMutationMessage({
      operation: "config set",
    });
    expect(message).toContain("Operation: config set");
  });
});
