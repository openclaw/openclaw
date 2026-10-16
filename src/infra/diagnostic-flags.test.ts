// Covers diagnostic flag matching and normalization.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isDiagnosticFlagEnabled } from "./diagnostic-flags.js";

describe("isDiagnosticFlagEnabled", () => {
  it("treats blank env values as no extra flags", () => {
    const cfg = {
      diagnostics: { flags: ["telegram.http"] },
    } as OpenClawConfig;

    expect(
      isDiagnosticFlagEnabled("telegram.http", cfg, {
        OPENCLAW_DIAGNOSTICS: "   ",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("treats false-like env values as disable overrides", () => {
    const cfg = {
      diagnostics: { flags: ["telegram.http"] },
    } as OpenClawConfig;

    for (const raw of ["0", "false", "off", "none"]) {
      expect(
        isDiagnosticFlagEnabled("telegram.http", cfg, {
          OPENCLAW_DIAGNOSTICS: raw,
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
  });
});

describe("diagnostic flag patterns", () => {
  it("matches exact, namespace, prefix, and wildcard rules", () => {
    for (const [flag, pattern] of [
      ["telegram.http", "telegram.http"],
      ["cache", "cache.*"],
      ["cache.hit", "cache.*"],
      ["tool.exec.fast", "tool.exec*"],
      ["anything", "all"],
      ["anything", "*"],
    ] as const) {
      expect(isDiagnosticFlagEnabled(flag, undefined, { OPENCLAW_DIAGNOSTICS: pattern })).toBe(
        true,
      );
    }
  });

  it("rejects blank and non-matching flags", () => {
    expect(isDiagnosticFlagEnabled("   ", undefined, { OPENCLAW_DIAGNOSTICS: "*" })).toBe(false);
    expect(
      isDiagnosticFlagEnabled("cache.hit", undefined, {
        OPENCLAW_DIAGNOSTICS: "cache.miss,tool.*",
      }),
    ).toBe(false);
  });
});
