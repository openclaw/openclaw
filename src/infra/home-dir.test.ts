import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandHomePrefix, resolveEffectiveHomeDir, resolveRequiredHomeDir } from "./home-dir.js";

describe("resolveEffectiveHomeDir", () => {
  it("prefers EASYHUB_HOME over HOME and USERPROFILE", () => {
    const env = {
      EASYHUB_HOME: "/srv/EasyHub-home",
      HOME: "/home/other",
      USERPROFILE: "C:/Users/other",
    } as NodeJS.ProcessEnv;

    expect(resolveEffectiveHomeDir(env, () => "/fallback")).toBe(
      path.resolve("/srv/EasyHub-home"),
    );
  });

  it("falls back to HOME then USERPROFILE then homedir", () => {
    expect(resolveEffectiveHomeDir({ HOME: "/home/alice" } as NodeJS.ProcessEnv)).toBe(
      path.resolve("/home/alice"),
    );
    expect(resolveEffectiveHomeDir({ USERPROFILE: "C:/Users/alice" } as NodeJS.ProcessEnv)).toBe(
      path.resolve("C:/Users/alice"),
    );
    expect(resolveEffectiveHomeDir({} as NodeJS.ProcessEnv, () => "/fallback")).toBe(
      path.resolve("/fallback"),
    );
  });

  it("expands EASYHUB_HOME when set to ~", () => {
    const env = {
      EASYHUB_HOME: "~/svc",
      HOME: "/home/alice",
    } as NodeJS.ProcessEnv;

    expect(resolveEffectiveHomeDir(env)).toBe(path.resolve("/home/alice/svc"));
  });
});

describe("resolveRequiredHomeDir", () => {
  it("returns cwd when no home source is available", () => {
    expect(
      resolveRequiredHomeDir({} as NodeJS.ProcessEnv, () => {
        throw new Error("no home");
      }),
    ).toBe(process.cwd());
  });

  it("returns a fully resolved path for EASYHUB_HOME", () => {
    const result = resolveRequiredHomeDir(
      { EASYHUB_HOME: "/custom/home" } as NodeJS.ProcessEnv,
      () => "/fallback",
    );
    expect(result).toBe(path.resolve("/custom/home"));
  });

  it("returns cwd when EASYHUB_HOME is tilde-only and no fallback home exists", () => {
    expect(
      resolveRequiredHomeDir({ EASYHUB_HOME: "~" } as NodeJS.ProcessEnv, () => {
        throw new Error("no home");
      }),
    ).toBe(process.cwd());
  });
});

describe("expandHomePrefix", () => {
  it("expands tilde using effective home", () => {
    const value = expandHomePrefix("~/x", {
      env: { EASYHUB_HOME: "/srv/EasyHub-home" } as NodeJS.ProcessEnv,
    });
    expect(value).toBe(`${path.resolve("/srv/EasyHub-home")}/x`);
  });

  it("keeps non-tilde values unchanged", () => {
    expect(expandHomePrefix("/tmp/x")).toBe("/tmp/x");
  });
});
