import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveProviderAuths } from "./provider-usage.auth.js";

describe("resolveProviderAuths key normalization", () => {
  let suiteRoot = "";
  let suiteCase = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-auth-suite-"));
  });

  afterAll(async () => {
    await fs.rm(suiteRoot, { recursive: true, force: true });
    suiteRoot = "";
    suiteCase = 0;
  });

  async function withSuiteHome<T>(
    fn: (home: string) => Promise<T>,
    env: Record<string, string | undefined>,
  ): Promise<T> {
    const base = path.join(suiteRoot, `case-${++suiteCase}`);
    await fs.mkdir(base, { recursive: true });
    await fs.mkdir(path.join(base, ".openclaw", "agents", "main", "sessions"), { recursive: true });

    const keysToRestore = new Set<string>([
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      ...Object.keys(env),
    ]);
    const snapshot: Record<string, string | undefined> = {};
    for (const key of keysToRestore) {
      snapshot[key] = process.env[key];
    }

    process.env.HOME = base;
    process.env.USERPROFILE = base;
    delete process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_STATE_DIR = path.join(base, ".openclaw");
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    try {
      return await fn(base);
    } finally {
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  async function writeAuthProfiles(home: string, profiles: Record<string, unknown>) {
    const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`,
      "utf8",
    );
  }

  async function writeConfig(home: string, config: Record<string, unknown>) {
    const stateDir = path.join(home, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
  }

  async function writeProfileOrder(home: string, provider: string, profileIds: string[]) {
    const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
    const parsed = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as Record<string, unknown>;
    const order = (parsed.order && typeof parsed.order === "object" ? parsed.order : {}) as Record<
      string,
      unknown
    >;
    order[provider] = profileIds;
    parsed.order = order;
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
  }

  async function writeLegacyPiAuth(home: string, raw: string) {
    const legacyDir = path.join(home, ".pi", "agent");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "auth.json"), raw, "utf8");
  }

  it("strips embedded CR/LF from env keys", async () => {
    await withSuiteHome(
      async () => {
        const auths = await resolveProviderAuths({
          providers: ["zai", "minimax", "xiaomi"],
        });
        expect(auths).toEqual([
          { provider: "zai", token: "zai-key" },
          { provider: "minimax", token: "minimax-key" },
          { provider: "xiaomi", token: "xiaomi-key" },
        ]);
      },
      {
        ZAI_API_KEY: "zai-\r\nkey",
        MINIMAX_API_KEY: "minimax-\r\nkey",
        XIAOMI_API_KEY: "xiaomi-\r\nkey",
      },
    );
  });

  it("strips embedded CR/LF from stored auth profiles (token + api_key)", async () => {
    await withSuiteHome(
      async (home) => {
        await writeAuthProfiles(home, {
          "minimax:default": { type: "token", provider: "minimax", token: "mini-\r\nmax" },
          "xiaomi:default": { type: "api_key", provider: "xiaomi", key: "xiao-\r\nmi" },
        });

        const auths = await resolveProviderAuths({
          providers: ["minimax", "xiaomi"],
        });
        expect(auths).toEqual([
          { provider: "minimax", token: "mini-max" },
          { provider: "xiaomi", token: "xiao-mi" },
        ]);
      },
      {
        MINIMAX_API_KEY: undefined,
        MINIMAX_CODE_PLAN_KEY: undefined,
        XIAOMI_API_KEY: undefined,
      },
    );
  });

  it("returns injected auth values unchanged", async () => {
    const auths = await resolveProviderAuths({
      providers: ["anthropic"],
      auth: [{ provider: "anthropic", token: "token-1", accountId: "acc-1" }],
    });
    expect(auths).toEqual([{ provider: "anthropic", token: "token-1", accountId: "acc-1" }]);
  });

  it("accepts z-ai env alias and normalizes embedded CR/LF", async () => {
    await withSuiteHome(
      async () => {
        const auths = await resolveProviderAuths({
          providers: ["zai"],
        });
        expect(auths).toEqual([{ provider: "zai", token: "zai-key" }]);
      },
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: "zai-\r\nkey",
      },
    );
  });

  it("falls back to legacy .pi auth file for zai keys even after os.homedir() is primed", async () => {
    // Prime os.homedir() to simulate long-lived workers that may have touched it before HOME changes.
    os.homedir();
    await withSuiteHome(
      async (home) => {
        await writeLegacyPiAuth(
          home,
          `${JSON.stringify({ "z-ai": { access: "legacy-zai-key" } }, null, 2)}\n`,
        );

        const auths = await resolveProviderAuths({
          providers: ["zai"],
        });
        expect(auths).toEqual([{ provider: "zai", token: "legacy-zai-key" }]);
      },
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: undefined,
      },
    );
  });

  it("extracts google oauth token from JSON payload in token profiles", async () => {
    await withSuiteHome(async (home) => {
      await writeAuthProfiles(home, {
        "google-gemini-cli:default": {
          type: "token",
          provider: "google-gemini-cli",
          token: '{"token":"google-oauth-token"}',
        },
      });

      const auths = await resolveProviderAuths({
        providers: ["google-gemini-cli"],
      });
      expect(auths).toEqual([{ provider: "google-gemini-cli", token: "google-oauth-token" }]);
    }, {});
  });

  it("keeps raw google token when token payload is not JSON", async () => {
    await withSuiteHome(async (home) => {
      await writeAuthProfiles(home, {
        "google-antigravity:default": {
          type: "token",
          provider: "google-antigravity",
          token: "plain-google-token",
        },
      });

      const auths = await resolveProviderAuths({
        providers: ["google-antigravity"],
      });
      expect(auths).toEqual([{ provider: "google-antigravity", token: "plain-google-token" }]);
    }, {});
  });

  it("uses config api keys when env and profiles are missing", async () => {
    await withSuiteHome(
      async (home) => {
        const modelDef = {
          id: "test-model",
          name: "Test Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1024,
          maxTokens: 256,
        };
        await writeConfig(home, {
          models: {
            providers: {
              zai: {
                baseUrl: "https://api.z.ai",
                models: [modelDef],
                apiKey: "cfg-zai-key",
              },
              minimax: {
                baseUrl: "https://api.minimaxi.com",
                models: [modelDef],
                apiKey: "cfg-minimax-key",
              },
              xiaomi: {
                baseUrl: "https://api.xiaomi.example",
                models: [modelDef],
                apiKey: "cfg-xiaomi-key",
              },
            },
          },
        });

        const auths = await resolveProviderAuths({
          providers: ["zai", "minimax", "xiaomi"],
        });
        expect(auths).toEqual([
          { provider: "zai", token: "cfg-zai-key" },
          { provider: "minimax", token: "cfg-minimax-key" },
          { provider: "xiaomi", token: "cfg-xiaomi-key" },
        ]);
      },
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: undefined,
        MINIMAX_API_KEY: undefined,
        MINIMAX_CODE_PLAN_KEY: undefined,
        XIAOMI_API_KEY: undefined,
      },
    );
  });

  it("returns no auth when providers have no configured credentials", async () => {
    await withSuiteHome(
      async () => {
        const auths = await resolveProviderAuths({
          providers: ["zai", "minimax", "xiaomi"],
        });
        expect(auths).toEqual([]);
      },
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: undefined,
        MINIMAX_API_KEY: undefined,
        MINIMAX_CODE_PLAN_KEY: undefined,
        XIAOMI_API_KEY: undefined,
      },
    );
  });

  it("uses zai api_key auth profiles when env and config are missing", async () => {
    await withSuiteHome(
      async (home) => {
        await writeAuthProfiles(home, {
          "zai:default": { type: "api_key", provider: "zai", key: "profile-zai-key" },
        });

        const auths = await resolveProviderAuths({
          providers: ["zai"],
        });
        expect(auths).toEqual([{ provider: "zai", token: "profile-zai-key" }]);
      },
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: undefined,
      },
    );
  });

  it("ignores invalid legacy z-ai auth files", async () => {
    await withSuiteHome(
      async (home) => {
        await writeLegacyPiAuth(home, "{not-json");
        const auths = await resolveProviderAuths({
          providers: ["zai"],
        });
        expect(auths).toEqual([]);
      },
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: undefined,
      },
    );
  });

  it("discovers oauth provider from config but skips mismatched profile providers", async () => {
    await withSuiteHome(async (home) => {
      await writeConfig(home, {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "token" },
          },
        },
      });
      await writeAuthProfiles(home, {
        "anthropic:default": {
          type: "token",
          provider: "zai",
          token: "mismatched-provider-token",
        },
      });

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
      });
      expect(auths).toEqual([]);
    }, {});
  });

  it("skips providers without oauth-compatible profiles", async () => {
    await withSuiteHome(async () => {
      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
      });
      expect(auths).toEqual([]);
    }, {});
  });

  it("skips oauth profiles that resolve without an api key and uses later profiles", async () => {
    await withSuiteHome(async (home) => {
      await writeAuthProfiles(home, {
        "anthropic:empty": {
          type: "token",
          provider: "anthropic",
          token: "expired-token",
          expires: Date.now() - 60_000,
        },
        "anthropic:valid": { type: "token", provider: "anthropic", token: "anthropic-token" },
      });
      await writeProfileOrder(home, "anthropic", ["anthropic:empty", "anthropic:valid"]);

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
      });
      expect(auths).toEqual([{ provider: "anthropic", token: "anthropic-token" }]);
    }, {});
  });

  it("skips api_key entries in oauth token resolution order", async () => {
    await withSuiteHome(async (home) => {
      await writeAuthProfiles(home, {
        "anthropic:api": { type: "api_key", provider: "anthropic", key: "api-key-1" },
        "anthropic:token": { type: "token", provider: "anthropic", token: "token-1" },
      });
      await writeProfileOrder(home, "anthropic", ["anthropic:api", "anthropic:token"]);

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
      });
      expect(auths).toEqual([{ provider: "anthropic", token: "token-1" }]);
    }, {});
  });
});
