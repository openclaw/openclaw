import { describe, expect, it } from "vitest";
import {
  assertConfigWriteAllowedInCurrentMode,
  formatNixModeConfigMutationMessage,
  NixModeConfigMutationError,
} from "./nix-mode-write-guard.js";

describe("nix-mode-write-guard", () => {
  it("throws NixModeConfigMutationError when NIX_MODE=1", () => {
    expect(() =>
      assertConfigWriteAllowedInCurrentMode({
        env: { OPENCLAW_NIX_MODE: "1" },
        operation: "doctor --generate-gateway-token",
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

  it("does not tell users to avoid non-config doctor repairs", () => {
    const message = formatNixModeConfigMutationMessage({
      operation: "doctor --fix",
    });
    expect(message).not.toContain("doctor repair/token-generation");
    expect(message).toContain("doctor --fix/--repair/--yes may still run non-config repairs");
  });
});
