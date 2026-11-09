import { describe, expect, it } from "vitest";
import { appendGitConfig, gitMaintenanceEnvironment } from "./git-maintenance-env.js";

describe("appendGitConfig", () => {
  it("starts at zero when the caller has no count", () => {
    const env = appendGitConfig({}, [["maintenance.auto", "false"]]);
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("maintenance.auto");
    expect(env.GIT_CONFIG_VALUE_0).toBe("false");
  });

  it("appends after a valid caller count", () => {
    const env = appendGitConfig(
      {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "example",
        GIT_CONFIG_KEY_1: "user.email",
        GIT_CONFIG_VALUE_1: "example@example.org",
      },
      [["gc.auto", "0"]],
    );
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_2).toBe("gc.auto");
    expect(env.GIT_CONFIG_VALUE_2).toBe("0");
  });

  it.each(["abc", "1.5", "0x10", "-1", "2x", " 1 2 "])(
    "does not propagate the malformed count %j",
    (raw) => {
      const env = appendGitConfig({ GIT_CONFIG_COUNT: raw }, [["gc.auto", "0"]]);
      expect(env.GIT_CONFIG_COUNT).toBe("1");
      expect(env.GIT_CONFIG_KEY_0).toBe("gc.auto");
      expect(Object.keys(env).some((key) => key.includes("NaN"))).toBe(false);
    },
  );

  it("keeps the maintenance environment usable when the ambient count is malformed", () => {
    const env = gitMaintenanceEnvironment({ GIT_CONFIG_COUNT: "nan" });
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("maintenance.auto");
    expect(env.GIT_CONFIG_KEY_1).toBe("gc.auto");
  });
});
