// Covers host-owned config mutability resolution and write-guard compatibility.
import { describe, expect, it } from "vitest";
import {
  ManagedConfigMutationError,
  OPENCLAW_CONFIG_MANAGED_ENV,
  resolveConfigOwnership,
  resolveIsConfigManaged,
} from "./config-ownership.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  NixModeConfigMutationError,
} from "./nix-mode-write-guard.js";

describe("config ownership", () => {
  it("defaults config ownership to OpenClaw", () => {
    expect(resolveConfigOwnership({})).toEqual({ mode: "mutable", owner: "openclaw" });
    expect(resolveIsConfigManaged({})).toBe(false);
  });

  it("recognizes only the exact managed-config host value", () => {
    expect(resolveConfigOwnership({ [OPENCLAW_CONFIG_MANAGED_ENV]: "1" })).toEqual({
      mode: "managed",
      owner: "external",
    });
    expect(resolveIsConfigManaged({ [OPENCLAW_CONFIG_MANAGED_ENV]: "1" })).toBe(true);
    expect(resolveConfigOwnership({ [OPENCLAW_CONFIG_MANAGED_ENV]: "true" })).toEqual({
      mode: "mutable",
      owner: "openclaw",
    });
  });

  it("preserves Nix ownership when both managed modes are present", () => {
    expect(
      resolveConfigOwnership({
        OPENCLAW_CONFIG_MANAGED: "1",
        OPENCLAW_NIX_MODE: "1",
      }),
    ).toEqual({ mode: "managed", owner: "nix" });
  });

  it("rejects external config writes with a stable error contract", () => {
    const configPath = "/etc/openclaw/openclaw.json";
    let rejection: unknown;
    try {
      assertConfigWriteAllowedInCurrentMode({
        configPath,
        env: { OPENCLAW_CONFIG_MANAGED: "1" },
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(ManagedConfigMutationError);
    expect(rejection).toMatchObject({
      code: "OPENCLAW_CONFIG_MANAGED",
      message: expect.stringContaining(configPath),
    });
  });

  it("preserves the Nix-specific error class, code, and guidance", () => {
    let rejection: unknown;
    try {
      assertConfigWriteAllowedInCurrentMode({ env: { OPENCLAW_NIX_MODE: "1" } });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(NixModeConfigMutationError);
    expect(rejection).toMatchObject({
      code: "OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE",
      message: expect.stringContaining("Agent-first Nix setup"),
    });
  });
});
