import { describe, expect, it, vi } from "vitest";
import {
  applyProcessEnvKeys,
  mergeProcessEnv,
  resolveDiagnosticProcessEnv,
  resolveEnvironmentValue,
} from "./process-env.js";

const routingEnv = (keys: string) =>
  Object.fromEntries(keys.split(" ").map((key) => [key, `/fixture/${key}`]));

it("applies only selected environment keys, preserving empty values and absence", () => {
  vi.stubEnv("OPENCLAW_TEST_APPLY_ENV_EMPTY", "previous");
  vi.stubEnv("OPENCLAW_TEST_APPLY_ENV_ABSENT", "previous");
  vi.stubEnv("OPENCLAW_TEST_APPLY_ENV_OUTSIDE", "retained");
  try {
    applyProcessEnvKeys(
      new Set(["OPENCLAW_TEST_APPLY_ENV_EMPTY", "OPENCLAW_TEST_APPLY_ENV_ABSENT"]),
      {
        OPENCLAW_TEST_APPLY_ENV_EMPTY: "",
        OPENCLAW_TEST_APPLY_ENV_OUTSIDE: "not selected",
      },
    );
    expect(process.env.OPENCLAW_TEST_APPLY_ENV_EMPTY).toBe("");
    expect(process.env.OPENCLAW_TEST_APPLY_ENV_ABSENT).toBeUndefined();
    expect(process.env.OPENCLAW_TEST_APPLY_ENV_OUTSIDE).toBe("retained");
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("resolveEnvironmentValue", () => {
  it("preserves exact POSIX keys and the existing Path fallback", () => {
    const env = { PATH: "exact", Path: "fallback", path: "lowercase" };

    expect(resolveEnvironmentValue(env, "PATH", "linux")).toBe("exact");
    expect(resolveEnvironmentValue({ Path: "fallback" }, "PATH", "linux")).toBe("fallback");
    expect(resolveEnvironmentValue({ path: "lowercase" }, "PATH", "linux")).toBeUndefined();
  });

  it("reads arbitrary Windows key casing with child_process precedence", () => {
    const env = { path: "lowercase", Path: "lexical-first", pAtHeXt: ".MiXeD" };

    expect(resolveEnvironmentValue(env, "PATH", "win32")).toBe("lexical-first");
    expect(resolveEnvironmentValue(env, "PATHEXT", "win32")).toBe(".MiXeD");
  });

  it("does not fall through a lexically preferred undefined Windows key", () => {
    expect(
      resolveEnvironmentValue({ PATH: undefined, Path: "later" }, "PATH", "win32"),
    ).toBeUndefined();
  });
});

describe("mergeProcessEnv", () => {
  it.each(["linux", "win32"] as const)(
    "preserves explicit prototype-named overrides and deletions on %s",
    (platform) => {
      const base = Object.freeze({ ["__proto__"]: "inherited", NORMAL_KEY: "control" });
      const override = Object.freeze({ ["__proto__"]: "configured", constructor: "ordinary" });
      const merged = mergeProcessEnv([base, override], platform);
      expect(merged).toEqual({
        ["__proto__"]: "configured",
        NORMAL_KEY: "control",
        constructor: "ordinary",
      });
      expect(mergeProcessEnv([merged, { ["__proto__"]: undefined }], platform)).toEqual({
        NORMAL_KEY: "control",
        constructor: "ordinary",
      });
    },
  );

  it.each([
    ["temp", "HOME", "base"],
    ["home", "TEMP", "inherited"],
    ["HOME", "TEMP", "inherited"],
  ] as const)(
    "reapplies later Windows %s overrides with their source spelling and order",
    (key, retainedKey, retainedValue) => {
      const source = Object.freeze({ TEMP: "inherited", HOME: "base" });
      const override = Object.freeze({ [key]: "configured" });
      expect(Object.entries(mergeProcessEnv([source, override], "win32"))).toEqual([
        [retainedKey, retainedValue],
        [key, "configured"],
      ]);
    },
  );

  it("keeps Node's lexicographically first Windows duplicate within one source", () => {
    expect(mergeProcessEnv([{ temp: "lower", Temp: "first" }], "win32")).toEqual({
      Temp: "first",
    });
  });

  it("removes inherited Windows keys before a later source reintroduces them", () => {
    const sources = [Object.freeze({ Path: "C:\\base" }), Object.freeze({ PATH: undefined })];
    expect(mergeProcessEnv(sources, "win32")).toEqual({});
    expect(mergeProcessEnv([...sources, Object.freeze({ path: "C:\\next" })], "win32")).toEqual({
      path: "C:\\next",
    });
  });

  it("preserves case-distinct POSIX keys", () => {
    expect(mergeProcessEnv([{ Path: "/base" }, { PATH: "/override" }], "linux")).toEqual({
      Path: "/base",
      PATH: "/override",
    });
  });
});

describe("resolveDiagnosticProcessEnv", () => {
  it.each([
    [
      "linux",
      "PATH Path HOME USER LOGNAME TMPDIR LANG LANGUAGE TZ LC_ALL LC_CTYPE LC_MESSAGES LC_COLLATE LC_MONETARY LC_NUMERIC LC_TIME",
      {
        path: "/unexpected",
        LC_UNKNOWN_CATEGORY: "synthetic",
        NEUTRAL_FLAG: "synthetic",
        NODE_OPTIONS: "--no-warnings",
        PSModulePath: "/fixture/modules",
        OPENAI_API_KEY: "synthetic",
      },
    ],
    [
      "win32",
      "Path systemRoot windir comSpec pathExt systemDrive userProfile homeDrive homePath userName userDomain temp tmp appData localAppData programData allUsersProfile programFiles programFiles(x86) programW6432 commonProgramFiles commonProgramFiles(x86) commonProgramW6432 PSModuleAnalysisCachePath",
      {
        PSModulePath: "C:\\ExtraModules",
        OPENCLAW_GATEWAY_TOKEN: "synthetic",
        https_proxy: "http://proxy.invalid",
      },
    ],
  ] as const)(
    "preserves only native %s routing, with original values and casing",
    (platform, keys, rejected) => {
      const native = routingEnv(keys);
      expect(
        resolveDiagnosticProcessEnv(Object.freeze({ ...native, ...rejected }), platform),
      ).toEqual(native);
    },
  );

  it("uses canonical Windows duplicate precedence, including undefined masking", () => {
    expect(
      resolveDiagnosticProcessEnv(
        { path: "lower", Path: "first", temp: "later", TEMP: undefined },
        "win32",
      ),
    ).toEqual({ Path: "first" });
    expect(resolveDiagnosticProcessEnv({ PATH: undefined, Path: "masked" }, "win32")).toEqual({});
  });
});
