import { describe, expect, it } from "vitest";
import { createPluginEnv, isSensitiveEnvKey } from "./env-sandbox.js";

describe("isSensitiveEnvKey", () => {
  it("blocks API key prefixes", () => {
    expect(isSensitiveEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(isSensitiveEnvKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSensitiveEnvKey("GOOGLE_APPLICATION_CREDENTIALS")).toBe(true);
    expect(isSensitiveEnvKey("AZURE_OPENAI_KEY")).toBe(true);
    expect(isSensitiveEnvKey("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isSensitiveEnvKey("ELEVENLABS_API_KEY")).toBe(true);
    expect(isSensitiveEnvKey("OPENROUTER_API_KEY")).toBe(true);
  });

  it("blocks channel token prefixes", () => {
    expect(isSensitiveEnvKey("TELEGRAM_BOT_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("DISCORD_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("SLACK_BOT_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("WHATSAPP_API_KEY")).toBe(true);
  });

  it("blocks suffix-matched keys", () => {
    expect(isSensitiveEnvKey("MY_CUSTOM_API_KEY")).toBe(true);
    expect(isSensitiveEnvKey("SOME_SERVICE_SECRET")).toBe(true);
    expect(isSensitiveEnvKey("DB_PASSWORD")).toBe(true);
    expect(isSensitiveEnvKey("OAUTH_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("SSH_PRIVATE_KEY")).toBe(true);
  });

  it("blocks exact sensitive keys", () => {
    expect(isSensitiveEnvKey("OPENCLAW_GATEWAY_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("OPENCLAW_GATEWAY_PASSWORD")).toBe(true);
  });

  it("allows non-sensitive keys", () => {
    expect(isSensitiveEnvKey("PATH")).toBe(false);
    expect(isSensitiveEnvKey("HOME")).toBe(false);
    expect(isSensitiveEnvKey("LANG")).toBe(false);
    expect(isSensitiveEnvKey("NODE_ENV")).toBe(false);
    expect(isSensitiveEnvKey("TERM")).toBe(false);
    expect(isSensitiveEnvKey("SHELL")).toBe(false);
    expect(isSensitiveEnvKey("USER")).toBe(false);
    expect(isSensitiveEnvKey("VITEST")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isSensitiveEnvKey("openai_api_key")).toBe(true);
    expect(isSensitiveEnvKey("Telegram_Bot_Token")).toBe(true);
  });
});

describe("createPluginEnv", () => {
  it("strips sensitive keys from environment", () => {
    const env = createPluginEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      NODE_ENV: "production",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      TELEGRAM_BOT_TOKEN: "123:ABC",
      OPENCLAW_GATEWAY_TOKEN: "gw-token",
      MY_CUSTOM_API_KEY: "custom-secret",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.NODE_ENV).toBe("production");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.MY_CUSTOM_API_KEY).toBeUndefined();
  });

  it("skips non-string values", () => {
    const env = createPluginEnv({
      GOOD: "yes",
      BAD: undefined,
    });

    expect(env.GOOD).toBe("yes");
    expect("BAD" in env).toBe(false);
  });

  it("returns empty object for all-sensitive env", () => {
    const env = createPluginEnv({
      OPENAI_API_KEY: "sk-1",
      ANTHROPIC_API_KEY: "sk-2",
    });

    expect(Object.keys(env)).toHaveLength(0);
  });
});
