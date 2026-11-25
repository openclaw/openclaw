import { devNull } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNestedGitEnv } from "./temp-repo.js";

describe("createNestedGitEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("isolates nested repositories from caller Git routing and configuration", () => {
    vi.stubEnv("GIT_DIR", "/synthetic/outer.git");
    vi.stubEnv("GIT_COMMON_DIR", "/synthetic/common.git");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "openclaw.fixture");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "caller-value");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/synthetic/global.gitconfig");

    const env = createNestedGitEnv();

    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_COMMON_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });
});
