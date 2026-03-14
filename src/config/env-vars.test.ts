import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  collectConfigRuntimeEnvVars,
  collectConfigServiceEnvVars,
  collectConfigEnvVars,
  applyConfigEnvVars,
} from "./env-vars.js";
import type { OpenClawConfig } from "./types.js";

describe("env-vars", () => {
  describe("collectConfigRuntimeEnvVars", () => {
    it("returns empty object when config is undefined", () => {
      expect(collectConfigRuntimeEnvVars(undefined)).toEqual({});
    });

    it("returns empty object when env is not configured", () => {
      const cfg: OpenClawConfig = {};
      expect(collectConfigRuntimeEnvVars(cfg)).toEqual({});
    });

    it("collects vars from env.vars", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            MY_VAR: "my_value",
            ANOTHER_VAR: "another_value",
          },
        },
      };
      expect(collectConfigRuntimeEnvVars(cfg)).toEqual({
        MY_VAR: "my_value",
        ANOTHER_VAR: "another_value",
      });
    });

    it("collects vars from env directly (legacy format)", () => {
      const cfg: OpenClawConfig = {
        env: {
          LEGACY_VAR: "legacy_value",
          shellEnv: "bash",
        } as OpenClawConfig["env"],
      };
      expect(collectConfigRuntimeEnvVars(cfg)).toEqual({
        LEGACY_VAR: "legacy_value",
      });
    });

    it("skips empty values", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            EMPTY_VAR: "",
            VALID_VAR: "valid",
          },
        },
      };
      expect(collectConfigRuntimeEnvVars(cfg)).toEqual({
        VALID_VAR: "valid",
      });
    });

    it("skips undefined values", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            VALID_VAR: "valid",
            UNDEFINED_VAR: undefined as unknown as string,
          },
        },
      };
      const result = collectConfigRuntimeEnvVars(cfg);
      expect(result).toHaveProperty("VALID_VAR", "valid");
      expect(result).not.toHaveProperty("UNDEFINED_VAR");
    });

    it("normalizes keys to uppercase", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            lowercase_var: "value1",
            Mixed_Case_Var: "value2",
          },
        },
      };
      const result = collectConfigRuntimeEnvVars(cfg);
      expect(result).toHaveProperty("LOWERCASE_VAR", "value1");
      expect(result).toHaveProperty("MIXED_CASE_VAR", "value2");
    });

    it("skips shellEnv key", () => {
      const cfg: OpenClawConfig = {
        env: {
          shellEnv: "zsh",
          vars: {
            REAL_VAR: "real_value",
          },
        },
      };
      const result = collectConfigRuntimeEnvVars(cfg);
      expect(result).not.toHaveProperty("shellEnv");
      expect(result).not.toHaveProperty("SHELLENV");
      expect(result).toHaveProperty("REAL_VAR", "real_value");
    });

    it("skips vars key in legacy format", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            INSIDE_VARS: "inside",
          },
          OUTSIDE_VAR: "outside",
        } as OpenClawConfig["env"],
      };
      const result = collectConfigRuntimeEnvVars(cfg);
      expect(result).toHaveProperty("OUTSIDE_VAR", "outside");
      expect(result).not.toHaveProperty("vars");
    });
  });

  describe("collectConfigServiceEnvVars", () => {
    it("returns same result as collectConfigRuntimeEnvVars", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            TEST_VAR: "test_value",
          },
        },
      };
      expect(collectConfigServiceEnvVars(cfg)).toEqual(
        collectConfigRuntimeEnvVars(cfg)
      );
    });
  });

  describe("collectConfigEnvVars (deprecated)", () => {
    it("returns same result as collectConfigRuntimeEnvVars", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            TEST_VAR: "test_value",
          },
        },
      };
      expect(collectConfigEnvVars(cfg)).toEqual(
        collectConfigRuntimeEnvVars(cfg)
      );
    });
  });

  describe("applyConfigEnvVars", () => {
    let mockEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      mockEnv = {};
    });

    afterEach(() => {
      // Cleanup if needed
    });

    it("applies config env vars to empty env", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            NEW_VAR: "new_value",
          },
        },
      };
      applyConfigEnvVars(cfg, mockEnv);
      expect(mockEnv.NEW_VAR).toBe("new_value");
    });

    it("does not overwrite existing env vars", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            EXISTING_VAR: "from_config",
          },
        },
      };
      mockEnv.EXISTING_VAR = "from_system";
      applyConfigEnvVars(cfg, mockEnv);
      expect(mockEnv.EXISTING_VAR).toBe("from_system");
    });

    it("applies multiple vars", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            VAR1: "value1",
            VAR2: "value2",
          },
        },
      };
      applyConfigEnvVars(cfg, mockEnv);
      expect(mockEnv.VAR1).toBe("value1");
      expect(mockEnv.VAR2).toBe("value2");
    });

    it("does not overwrite existing vars even if empty", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            EMPTY_BUT_SET: "from_config",
          },
        },
      };
      mockEnv.EMPTY_BUT_SET = "";
      applyConfigEnvVars(cfg, mockEnv);
      expect(mockEnv.EMPTY_BUT_SET).toBe("");
    });

    it("overwrites if existing is whitespace only", () => {
      const cfg: OpenClawConfig = {
        env: {
          vars: {
            WHITESPACE_VAR: "from_config",
          },
        },
      };
      mockEnv.WHITESPACE_VAR = "   ";
      applyConfigEnvVars(cfg, mockEnv);
      expect(mockEnv.WHITESPACE_VAR).toBe("from_config");
    });
  });
});
