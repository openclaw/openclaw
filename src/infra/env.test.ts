import { describe, expect, it } from "vitest";
import { isTruthyEnvValue, normalizeZaiEnv } from "./env.js";

describe("normalizeZaiEnv", () => {
  function withZaiEnv(env: { zaiApiKey?: string; legacyZaiApiKey?: string }, run: () => void) {
    const prevZai = process.env.ZAI_API_KEY;
    const prevLegacy = process.env.Z_AI_API_KEY;
    if (env.zaiApiKey === undefined) {
      delete process.env.ZAI_API_KEY;
    } else {
      process.env.ZAI_API_KEY = env.zaiApiKey;
    }
    if (env.legacyZaiApiKey === undefined) {
      delete process.env.Z_AI_API_KEY;
    } else {
      process.env.Z_AI_API_KEY = env.legacyZaiApiKey;
    }
    try {
      run();
    } finally {
      if (prevZai === undefined) {
        delete process.env.ZAI_API_KEY;
      } else {
        process.env.ZAI_API_KEY = prevZai;
      }
      if (prevLegacy === undefined) {
        delete process.env.Z_AI_API_KEY;
      } else {
        process.env.Z_AI_API_KEY = prevLegacy;
      }
    }
  }

  it("copies Z_AI_API_KEY to ZAI_API_KEY when missing", () => {
    withZaiEnv({ zaiApiKey: "", legacyZaiApiKey: "zai-legacy" }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("zai-legacy");
    });
  });

  it("does not override existing ZAI_API_KEY", () => {
    withZaiEnv({ zaiApiKey: "zai-current", legacyZaiApiKey: "zai-legacy" }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("zai-current");
    });
  });

  it("ignores blank legacy Z_AI_API_KEY values", () => {
    withZaiEnv({ zaiApiKey: "", legacyZaiApiKey: "   " }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("");
    });
  });
});

describe("isTruthyEnvValue", () => {
  it("accepts common truthy values", () => {
    expect(isTruthyEnvValue("1")).toBe(true);
    expect(isTruthyEnvValue("true")).toBe(true);
    expect(isTruthyEnvValue(" yes ")).toBe(true);
    expect(isTruthyEnvValue("ON")).toBe(true);
  });

  it("rejects other values", () => {
    expect(isTruthyEnvValue("0")).toBe(false);
    expect(isTruthyEnvValue("false")).toBe(false);
    expect(isTruthyEnvValue("")).toBe(false);
    expect(isTruthyEnvValue(undefined)).toBe(false);
  });
});
