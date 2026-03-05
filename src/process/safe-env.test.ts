import { describe, expect, it } from "vitest";
import { __testing, buildSafeSubprocessEnv, buildSanitisedSubprocessEnv } from "./safe-env.js";

const { isSafeSystemKey, looksLikeCredential } = __testing;

describe("isSafeSystemKey", () => {
  it("allows basic system vars", () => {
    for (const key of ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"]) {
      expect(isSafeSystemKey(key)).toBe(true);
    }
  });

  it("allows LC_ prefixed vars", () => {
    expect(isSafeSystemKey("LC_ALL")).toBe(true);
    expect(isSafeSystemKey("LC_CTYPE")).toBe(true);
  });

  it("allows XDG_ prefixed vars", () => {
    expect(isSafeSystemKey("XDG_RUNTIME_DIR")).toBe(true);
  });

  it("rejects credential-like vars", () => {
    expect(isSafeSystemKey("AWS_SECRET_ACCESS_KEY")).toBe(false);
    expect(isSafeSystemKey("OPENAI_API_KEY")).toBe(false);
    expect(isSafeSystemKey("DATABASE_URL")).toBe(false);
  });

  it("rejects arbitrary vars", () => {
    expect(isSafeSystemKey("MY_CUSTOM_VAR")).toBe(false);
    expect(isSafeSystemKey("TWILIO_AUTH_TOKEN")).toBe(false);
  });
});

describe("looksLikeCredential", () => {
  it("detects common credential patterns", () => {
    expect(looksLikeCredential("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(looksLikeCredential("OPENAI_API_KEY")).toBe(true);
    expect(looksLikeCredential("GITHUB_TOKEN")).toBe(true);
    expect(looksLikeCredential("GH_TOKEN")).toBe(true);
    expect(looksLikeCredential("NPM_TOKEN")).toBe(true);
    expect(looksLikeCredential("DATABASE_URL")).toBe(true);
    expect(looksLikeCredential("REDIS_URL")).toBe(true);
    expect(looksLikeCredential("TWILIO_AUTH_TOKEN")).toBe(true);
    expect(looksLikeCredential("ANTHROPIC_API_KEY")).toBe(true);
    expect(looksLikeCredential("MY_SERVICE_SECRET")).toBe(true);
    expect(looksLikeCredential("SOME_PASSWORD")).toBe(true);
    expect(looksLikeCredential("MY_PRIVATE_KEY")).toBe(true);
  });

  it("does not flag safe system vars", () => {
    expect(looksLikeCredential("PATH")).toBe(false);
    expect(looksLikeCredential("HOME")).toBe(false);
    expect(looksLikeCredential("TERM")).toBe(false);
    expect(looksLikeCredential("NODE_ENV")).toBe(false);
    expect(looksLikeCredential("LOBSTER_MODE")).toBe(false);
  });
});

describe("buildSafeSubprocessEnv", () => {
  const fakeSource: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    USER: "testuser",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "xterm",
    TMPDIR: "/tmp",
    OPENAI_API_KEY: "sk-secret-123",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    MY_CUSTOM_VAR: "value",
    ZCA_PROFILE: "myprofile",
    LOBSTER_MODE: "tool",
  };

  it("only includes safe system vars by default", () => {
    const env = buildSafeSubprocessEnv({ source: fakeSource });
    expect(env).toHaveProperty("PATH", "/usr/bin");
    expect(env).toHaveProperty("HOME", "/home/user");
    expect(env).toHaveProperty("USER", "testuser");
    expect(env).toHaveProperty("LANG", "en_US.UTF-8");
    expect(env).toHaveProperty("LC_ALL", "en_US.UTF-8");
    expect(env).toHaveProperty("TERM", "xterm");
    expect(env).toHaveProperty("TMPDIR", "/tmp");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("MY_CUSTOM_VAR");
    expect(env).not.toHaveProperty("ZCA_PROFILE");
    expect(env).not.toHaveProperty("LOBSTER_MODE");
  });

  it("includes extraKeys when specified", () => {
    const env = buildSafeSubprocessEnv({
      source: fakeSource,
      extraKeys: ["MY_CUSTOM_VAR"],
    });
    expect(env).toHaveProperty("MY_CUSTOM_VAR", "value");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("includes extraPrefixes when specified", () => {
    const env = buildSafeSubprocessEnv({
      source: fakeSource,
      extraPrefixes: ["ZCA_"],
    });
    expect(env).toHaveProperty("ZCA_PROFILE", "myprofile");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("MY_CUSTOM_VAR");
  });

  it("applies overrides", () => {
    const env = buildSafeSubprocessEnv({
      source: fakeSource,
      overrides: { FORCE_COLOR: "1", HOME: "/override" },
    });
    expect(env).toHaveProperty("FORCE_COLOR", "1");
    expect(env).toHaveProperty("HOME", "/override");
  });

  it("skips undefined values in source", () => {
    const env = buildSafeSubprocessEnv({
      source: { PATH: "/usr/bin", UNDEF: undefined },
    });
    expect(env).toHaveProperty("PATH");
    expect(env).not.toHaveProperty("UNDEF");
  });
});

describe("buildSanitisedSubprocessEnv", () => {
  const fakeSource: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    NODE_ENV: "production",
    LOBSTER_MODE: "tool",
    OPENAI_API_KEY: "sk-secret-123",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    AWS_SESSION_TOKEN: "sess-tok",
    DATABASE_URL: "postgres://...",
    GITHUB_TOKEN: "ghp_xxx",
    MY_SERVICE_SECRET: "s3cr3t",
    MY_API_KEY: "apikey",
    SAFE_CUSTOM_VAR: "ok",
  };

  it("strips credential-shaped vars", () => {
    const env = buildSanitisedSubprocessEnv({ source: fakeSource });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("AWS_SESSION_TOKEN");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("MY_SERVICE_SECRET");
    expect(env).not.toHaveProperty("MY_API_KEY");
  });

  it("keeps safe vars", () => {
    const env = buildSanitisedSubprocessEnv({ source: fakeSource });
    expect(env).toHaveProperty("PATH", "/usr/bin");
    expect(env).toHaveProperty("HOME", "/home/user");
    expect(env).toHaveProperty("NODE_ENV", "production");
    expect(env).toHaveProperty("LOBSTER_MODE", "tool");
    expect(env).toHaveProperty("SAFE_CUSTOM_VAR", "ok");
  });

  it("applies overrides", () => {
    const env = buildSanitisedSubprocessEnv({
      source: fakeSource,
      overrides: { EXTRA: "val" },
    });
    expect(env).toHaveProperty("EXTRA", "val");
  });
});
