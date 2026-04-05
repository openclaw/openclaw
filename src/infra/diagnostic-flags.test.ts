import { describe, expect, it } from "vitest";
import type { MullusiConfig } from "../config/config.js";
import {
  isDiagnosticFlagEnabled,
  matchesDiagnosticFlag,
  resolveDiagnosticFlags,
} from "./diagnostic-flags.js";

describe("resolveDiagnosticFlags", () => {
  it("normalizes and dedupes config and env flags", () => {
    const cfg = {
      diagnostics: { flags: [" Telegram.Http ", "cache.*", "CACHE.*"] },
    } as MullusiConfig;
    const env = {
      MULLUSI_DIAGNOSTICS: " foo, Cache.*  telegram.http  ",
    } as NodeJS.ProcessEnv;

    expect(resolveDiagnosticFlags(cfg, env)).toEqual(["telegram.http", "cache.*", "foo"]);
  });

  it("treats false-like env values as no extra flags", () => {
    const cfg = {
      diagnostics: { flags: ["telegram.http"] },
    } as MullusiConfig;

    for (const raw of ["0", "false", "off", "none", "   "]) {
      expect(
        resolveDiagnosticFlags(cfg, {
          MULLUSI_DIAGNOSTICS: raw,
        } as NodeJS.ProcessEnv),
      ).toEqual(["telegram.http"]);
    }
  });
});

describe("matchesDiagnosticFlag", () => {
  it("matches exact, namespace, prefix, and wildcard rules", () => {
    expect(matchesDiagnosticFlag("telegram.http", ["telegram.http"])).toBe(true);
    expect(matchesDiagnosticFlag("cache", ["cache.*"])).toBe(true);
    expect(matchesDiagnosticFlag("cache.hit", ["cache.*"])).toBe(true);
    expect(matchesDiagnosticFlag("tool.exec.fast", ["tool.exec*"])).toBe(true);
    expect(matchesDiagnosticFlag("anything", ["all"])).toBe(true);
    expect(matchesDiagnosticFlag("anything", ["*"])).toBe(true);
  });

  it("rejects blank and non-matching flags", () => {
    expect(matchesDiagnosticFlag("   ", ["*"])).toBe(false);
    expect(matchesDiagnosticFlag("cache.hit", ["cache.miss", "tool.*"])).toBe(false);
  });
});

describe("isDiagnosticFlagEnabled", () => {
  it("resolves config and env together before matching", () => {
    const cfg = {
      diagnostics: { flags: ["gateway.*"] },
    } as MullusiConfig;
    const env = {
      MULLUSI_DIAGNOSTICS: "telegram.http",
    } as NodeJS.ProcessEnv;

    expect(isDiagnosticFlagEnabled("gateway.ws", cfg, env)).toBe(true);
    expect(isDiagnosticFlagEnabled("telegram.http", cfg, env)).toBe(true);
    expect(isDiagnosticFlagEnabled("slack.http", cfg, env)).toBe(false);
  });
});
