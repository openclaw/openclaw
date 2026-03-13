import { describe, expect, it } from "vitest";
import { applyConfigEnvVars } from "./env-vars.js";
import type { OpenClawConfig } from "./types.js";

describe("applyConfigEnvVars", () => {
  it("does not crash on non-string values in env.vars (#42363)", () => {
    // Config with mixed value types — numeric/boolean come from JSON configs
    // where users write e.g. { "env": { "vars": { "PORT": 8080 } } }
    const cfg = {
      env: {
        vars: {
          API_TOKEN: "sk-test-123",
          PORT: 8080,
          DEBUG: true,
        },
      },
    } as unknown as OpenClawConfig;

    const env: Record<string, string | undefined> = {};
    expect(() => applyConfigEnvVars(cfg, env as NodeJS.ProcessEnv)).not.toThrow();
    expect(env.API_TOKEN).toBe("sk-test-123");
    // non-string values are skipped, not coerced
    expect(env.PORT).toBeUndefined();
    expect(env.DEBUG).toBeUndefined();
  });
});
