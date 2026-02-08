import { describe, expect, it } from "vitest";
import { restoreEnvVarRefs } from "./env-ref-preservation.js";

describe("restoreEnvVarRefs", () => {
  describe("string values", () => {
    it("preserves a ${VAR} reference when the resolved value matches", () => {
      const result = restoreEnvVarRefs(
        "${TELEGRAM_BOT_TOKEN}",
        "8088341295:AAE19k8gN2LalEpJ82kn-PAj0VgEyA1vCdA",
        { TELEGRAM_BOT_TOKEN: "8088341295:AAE19k8gN2LalEpJ82kn-PAj0VgEyA1vCdA" },
      );
      expect(result).toBe("${TELEGRAM_BOT_TOKEN}");
    });

    it("uses the resolved value when it differs from the env expansion", () => {
      const result = restoreEnvVarRefs("${OLD_TOKEN}", "new-value-set-by-user", {
        OLD_TOKEN: "old-value",
      });
      expect(result).toBe("new-value-set-by-user");
    });

    it("uses the resolved value when raw has no env var reference", () => {
      const result = restoreEnvVarRefs("plain-value", "plain-value", {});
      expect(result).toBe("plain-value");
    });

    it("preserves inline ${VAR} with prefix/suffix", () => {
      const result = restoreEnvVarRefs("https://${API_HOST}/v1", "https://api.example.com/v1", {
        API_HOST: "api.example.com",
      });
      expect(result).toBe("https://${API_HOST}/v1");
    });

    it("preserves multiple ${VAR} references in one string", () => {
      const result = restoreEnvVarRefs(
        "${PROTOCOL}://${HOST}:${PORT}",
        "https://api.example.com:8443",
        { PROTOCOL: "https", HOST: "api.example.com", PORT: "8443" },
      );
      expect(result).toBe("${PROTOCOL}://${HOST}:${PORT}");
    });

    it("falls through when env var is no longer set", () => {
      const result = restoreEnvVarRefs("${GONE_VAR}", "some-fallback", {});
      expect(result).toBe("some-fallback");
    });
  });

  describe("nested objects", () => {
    it("preserves env var refs in nested object fields", () => {
      const raw = {
        channels: {
          telegram: {
            botToken: "${TELEGRAM_BOT_TOKEN}",
          },
        },
        meta: {
          lastTouchedAt: "2026-01-01T00:00:00Z",
        },
      };
      const resolved = {
        channels: {
          telegram: {
            botToken: "secret-token-123",
          },
        },
        meta: {
          lastTouchedAt: "2026-02-05T12:00:00Z",
        },
      };
      const env = { TELEGRAM_BOT_TOKEN: "secret-token-123" };
      const result = restoreEnvVarRefs(raw, resolved, env);
      expect(result).toEqual({
        channels: {
          telegram: {
            botToken: "${TELEGRAM_BOT_TOKEN}",
          },
        },
        meta: {
          lastTouchedAt: "2026-02-05T12:00:00Z",
        },
      });
    });

    it("preserves multiple secrets across different subtrees", () => {
      const raw = {
        models: {
          providers: {
            openai: { apiKey: "${OPENAI_API_KEY}" },
            anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
          },
        },
        gateway: {
          auth: { token: "${GATEWAY_TOKEN}" },
        },
      };
      const resolved = {
        models: {
          providers: {
            openai: { apiKey: "sk-xxx" },
            anthropic: { apiKey: "sk-yyy" },
          },
        },
        gateway: {
          auth: { token: "gw-secret" },
        },
      };
      const env = {
        OPENAI_API_KEY: "sk-xxx",
        ANTHROPIC_API_KEY: "sk-yyy",
        GATEWAY_TOKEN: "gw-secret",
      };
      const result = restoreEnvVarRefs(raw, resolved, env);
      expect(result).toEqual({
        models: {
          providers: {
            openai: { apiKey: "${OPENAI_API_KEY}" },
            anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
          },
        },
        gateway: {
          auth: { token: "${GATEWAY_TOKEN}" },
        },
      });
    });

    it("keeps new fields added by the resolved config", () => {
      const raw = { existing: "value" };
      const resolved = { existing: "value", newField: "added" };
      const result = restoreEnvVarRefs(raw, resolved, {});
      expect(result).toEqual({ existing: "value", newField: "added" });
    });

    it("drops fields removed from the resolved config", () => {
      const raw = { kept: "yes", removed: "${SECRET}" };
      const resolved = { kept: "yes" };
      const result = restoreEnvVarRefs(raw, resolved, { SECRET: "s" });
      expect(result).toEqual({ kept: "yes" });
    });
  });

  describe("arrays", () => {
    it("preserves env var refs in array elements", () => {
      const raw = ["${A}", "${B}", "literal"];
      const resolved = ["val-a", "val-b", "literal"];
      const env = { A: "val-a", B: "val-b" };
      const result = restoreEnvVarRefs(raw, resolved, env);
      expect(result).toEqual(["${A}", "${B}", "literal"]);
    });

    it("uses resolved array when lengths differ", () => {
      const raw = ["${A}"];
      const resolved = ["val-a", "val-b"];
      const env = { A: "val-a" };
      const result = restoreEnvVarRefs(raw, resolved, env);
      expect(result).toEqual(["val-a", "val-b"]);
    });

    it("preserves refs in arrays nested inside objects", () => {
      const raw = {
        providers: [
          { name: "openai", apiKey: "${OPENAI_KEY}" },
          { name: "anthropic", apiKey: "${ANTHROPIC_KEY}" },
        ],
      };
      const resolved = {
        providers: [
          { name: "openai", apiKey: "sk-xxx" },
          { name: "anthropic", apiKey: "sk-yyy" },
        ],
      };
      const env = { OPENAI_KEY: "sk-xxx", ANTHROPIC_KEY: "sk-yyy" };
      const result = restoreEnvVarRefs(raw, resolved, env);
      expect(result).toEqual({
        providers: [
          { name: "openai", apiKey: "${OPENAI_KEY}" },
          { name: "anthropic", apiKey: "${ANTHROPIC_KEY}" },
        ],
      });
    });
  });

  describe("type mismatches", () => {
    it("returns resolved value when types differ (string vs number)", () => {
      const result = restoreEnvVarRefs("${PORT}", 8080, { PORT: "8080" });
      expect(result).toBe(8080);
    });

    it("returns resolved value when types differ (object vs string)", () => {
      const result = restoreEnvVarRefs({ key: "value" }, "replaced", {});
      expect(result).toBe("replaced");
    });

    it("handles null resolved values", () => {
      const result = restoreEnvVarRefs("${VAR}", null, { VAR: "value" });
      expect(result).toBeNull();
    });
  });

  describe("real-world config scenario", () => {
    it("preserves secrets during meta.lastTouchedAt update", () => {
      const rawOnDisk = {
        channels: {
          telegram: {
            botToken: "${TELEGRAM_BOT_TOKEN}",
            allowedUsers: ["user1"],
          },
        },
        models: {
          primary: "anthropic/claude-opus-4-5",
          providers: {
            anthropic: {
              apiKey: "${ANTHROPIC_API_KEY}",
            },
          },
        },
        meta: {
          lastTouchedVersion: "2026.2.2-3",
          lastTouchedAt: "2026-02-01T00:00:00.000Z",
        },
      };

      const resolvedConfigToWrite = {
        channels: {
          telegram: {
            botToken: "8088341295:AAE19k8gN2LalEpJ82kn-PAj0VgEyA1vCdA",
            allowedUsers: ["user1"],
          },
        },
        models: {
          primary: "anthropic/claude-opus-4-5",
          providers: {
            anthropic: {
              apiKey: "sk-ant-secret-key-here",
            },
          },
        },
        meta: {
          lastTouchedVersion: "2026.2.3-1",
          lastTouchedAt: "2026-02-05T12:00:00.000Z",
        },
      };

      const env = {
        TELEGRAM_BOT_TOKEN: "8088341295:AAE19k8gN2LalEpJ82kn-PAj0VgEyA1vCdA",
        ANTHROPIC_API_KEY: "sk-ant-secret-key-here",
      };

      const result = restoreEnvVarRefs(rawOnDisk, resolvedConfigToWrite, env);

      expect(result).toEqual({
        channels: {
          telegram: {
            botToken: "${TELEGRAM_BOT_TOKEN}",
            allowedUsers: ["user1"],
          },
        },
        models: {
          primary: "anthropic/claude-opus-4-5",
          providers: {
            anthropic: {
              apiKey: "${ANTHROPIC_API_KEY}",
            },
          },
        },
        meta: {
          lastTouchedVersion: "2026.2.3-1",
          lastTouchedAt: "2026-02-05T12:00:00.000Z",
        },
      });
    });
  });
});
