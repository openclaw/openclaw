import { describe, expect, it } from "vitest";
import {
  applyHwvaultPresetToExecProvider,
  getHwvaultDefaultCommandForPlatform,
} from "./configure.js";

describe("getHwvaultDefaultCommandForPlatform", () => {
  it("returns empty default for Windows", () => {
    expect(getHwvaultDefaultCommandForPlatform("win32")).toBe("");
  });

  it("returns resolver path for non-Windows", () => {
    expect(getHwvaultDefaultCommandForPlatform("linux")).toBe(
      "/usr/local/bin/openclaw-hwvault-resolver",
    );
  });
});

describe("applyHwvaultPresetToExecProvider", () => {
  it("adds required pass-through env names and policy env values", () => {
    const result = applyHwvaultPresetToExecProvider({
      passEnv: ["PATH", "HWVAULT_BIN"],
      env: { EXISTING: "1" },
      trustRoots: "tpm,yubikey",
      policyPath: " ~/.config/hwvault/openclaw-policy.json ",
    });

    expect(result.passEnv).toEqual([
      "PATH",
      "HWVAULT_BIN",
      "OPENCLAW_AGENT_ID",
      "OPENCLAW_SESSION_KEY",
      "OPENCLAW_DELEGATION_AUDIENCE",
    ]);
    expect(result.env).toMatchObject({
      EXISTING: "1",
      HWVAULT_POLICY_PATH: "~/.config/hwvault/openclaw-policy.json",
      HWVAULT_TRUST_ROOTS: "tpm,yubikey",
    });
  });

  it("does not duplicate required env keys", () => {
    const result = applyHwvaultPresetToExecProvider({
      passEnv: [
        "OPENCLAW_AGENT_ID",
        "OPENCLAW_SESSION_KEY",
        "OPENCLAW_DELEGATION_AUDIENCE",
        "HWVAULT_BIN",
      ],
      env: {},
      trustRoots: "tpm",
      policyPath: "/tmp/policy.json",
    });

    expect(result.passEnv).toEqual([
      "OPENCLAW_AGENT_ID",
      "OPENCLAW_SESSION_KEY",
      "OPENCLAW_DELEGATION_AUDIENCE",
      "HWVAULT_BIN",
    ]);
    expect(result.env).toMatchObject({
      HWVAULT_POLICY_PATH: "/tmp/policy.json",
      HWVAULT_TRUST_ROOTS: "tpm",
    });
  });
});
