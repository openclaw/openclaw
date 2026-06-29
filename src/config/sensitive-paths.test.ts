// Covers config path sensitivity classification -- pattern matching, whitelist
// exemption, and local-service env override.
import { describe, expect, it } from "vitest";
import { isSensitiveConfigPath } from "./sensitive-paths.js";

describe("isSensitiveConfigPath", () => {
  // -- Sensitive pattern matching ---------------------------------------

  describe("matches sensitive patterns", () => {
    it("matches paths ending with token", () => {
      expect(isSensitiveConfigPath("myToken")).toBe(true);
      expect(isSensitiveConfigPath("auth_token")).toBe(true);
      expect(isSensitiveConfigPath("api.bot.token")).toBe(true);
    });

    it("matches paths containing password", () => {
      expect(isSensitiveConfigPath("password")).toBe(true);
      expect(isSensitiveConfigPath("dbPassword")).toBe(true);
      expect(isSensitiveConfigPath("some.password.field")).toBe(true);
    });

    it("matches paths containing secret", () => {
      expect(isSensitiveConfigPath("clientSecret")).toBe(true);
      expect(isSensitiveConfigPath("my_secret_key")).toBe(true);
    });

    it("matches paths matching api.?key", () => {
      expect(isSensitiveConfigPath("apiKey")).toBe(true);
      expect(isSensitiveConfigPath("apikey")).toBe(true);
      expect(isSensitiveConfigPath("api_key")).toBe(true);
      expect(isSensitiveConfigPath("openai_api_key")).toBe(true);
    });

    it("matches paths matching encrypt.?key", () => {
      expect(isSensitiveConfigPath("encryptKey")).toBe(true);
      expect(isSensitiveConfigPath("encrypt_key")).toBe(true);
    });

    it("matches paths matching private.?key", () => {
      expect(isSensitiveConfigPath("privateKey")).toBe(true);
      expect(isSensitiveConfigPath("private_key")).toBe(true);
    });

    it("matches paths ending with serviceaccount or serviceaccountref", () => {
      expect(isSensitiveConfigPath("serviceAccount")).toBe(true);
      expect(isSensitiveConfigPath("gcpServiceAccountRef")).toBe(true);
      expect(isSensitiveConfigPath("azure.serviceaccount")).toBe(true);
    });

    it("is case-insensitive across all patterns", () => {
      expect(isSensitiveConfigPath("APITOKEN")).toBe(true);
      expect(isSensitiveConfigPath("PASSWORD")).toBe(true);
      expect(isSensitiveConfigPath("SECRET")).toBe(true);
      expect(isSensitiveConfigPath("APIKEY")).toBe(true);
      expect(isSensitiveConfigPath("PRIVATEKEY")).toBe(true);
    });

    it("matches fully qualified path segments", () => {
      expect(isSensitiveConfigPath("providers.openai.apiKey")).toBe(true);
      expect(isSensitiveConfigPath("channels.discord.botToken")).toBe(true);
      expect(isSensitiveConfigPath("plugins.myapp.clientSecret")).toBe(true);
    });
  });

  // -- Whitelist exemption ----------------------------------------------

  describe("whitelisted suffixes are not sensitive", () => {
    it.each([
      "maxTokens",
      "maxOutputTokens",
      "maxInputTokens",
      "maxCompletionTokens",
      "contextTokens",
      "totalTokens",
      "tokenCount",
      "tokenLimit",
      "tokenBudget",
    ])("exempts token-related whitelist suffix: %s", (path) => {
      expect(isSensitiveConfigPath(path)).toBe(false);
    });

    it("exempts passwordFile suffix", () => {
      // passwordFile is whitelisted -- even though it contains "password"
      expect(isSensitiveConfigPath("passwordFile")).toBe(false);
      expect(isSensitiveConfigPath("sshPasswordFile")).toBe(false);
    });

    it("exempts whitelist suffixes case-insensitively", () => {
      expect(isSensitiveConfigPath("MAXTOKENS")).toBe(false);
      expect(isSensitiveConfigPath("PASSWORDFILE")).toBe(false);
      expect(isSensitiveConfigPath("MaxTokens")).toBe(false);
      expect(isSensitiveConfigPath("PasswordFile")).toBe(false);
    });

    it("whitelist does not leak to shorter suffixes", () => {
      // "maxtokens" is whitelisted; bare "token" is not.
      expect(isSensitiveConfigPath("token")).toBe(true);
      // "passwordfile" is whitelisted; bare "password" is not.
      expect(isSensitiveConfigPath("password")).toBe(true);
    });

    it("whitelist only applies at exact suffix match", () => {
      // "maxtokens" is whitelisted when at path end; embedded does not exempt.
      expect(isSensitiveConfigPath("maxToken")).toBe(true);
    });
  });

  // -- Local service env ------------------------------------------------

  describe("local service env values are always sensitive", () => {
    it("flags localservice.env paths", () => {
      expect(isSensitiveConfigPath("localservice.env.MY_VAR")).toBe(true);
      expect(isSensitiveConfigPath("plugins.myapp.localservice.env.API_KEY")).toBe(true);
    });

    it("is case-insensitive for localservice.env", () => {
      expect(isSensitiveConfigPath("LocalService.ENV.myvar")).toBe(true);
      expect(isSensitiveConfigPath("LOCALSERVICE.ENV.TOKEN")).toBe(true);
    });

    it("takes priority over whitelist exemption", () => {
      // Even if the variable name is a whitelisted suffix, local service env wins.
      expect(isSensitiveConfigPath("localservice.env.maxTokens")).toBe(true);
    });
  });

  // -- Non-sensitive paths ----------------------------------------------

  describe("returns false for non-sensitive paths", () => {
    it.each([
      ["model", "plain model name"],
      ["temperature", "model parameter"],
      ["systemPrompt", "prompt text"],
      ["plugins.myapp.enabled", "plugin toggle"],
      ["channels.discord.guildId", "channel identifier"],
      ["agents.defaults.maxConcurrent", "numeric limit"],
      ["", "empty string"],
    ])("rejects %s (%s)", (path) => {
      expect(isSensitiveConfigPath(path)).toBe(false);
    });
  });

  // -- Composite path ---------------------------------------------------

  describe("composite config paths", () => {
    it("correctly classifies deeply nested paths", () => {
      // Sensitive: has apiKey in the path
      expect(isSensitiveConfigPath("plugins.myapp.auth.apiKey")).toBe(true);
      // Not sensitive: no sensitive pattern
      expect(isSensitiveConfigPath("plugins.myapp.auth.method")).toBe(false);
      // Whitelisted: ends with tokenLimit
      expect(isSensitiveConfigPath("plugins.myapp.auth.tokenLimit")).toBe(false);
      // Local service env overrides everything
      expect(isSensitiveConfigPath("plugins.myapp.localservice.env.tokenLimit")).toBe(true);
    });
  });
});
