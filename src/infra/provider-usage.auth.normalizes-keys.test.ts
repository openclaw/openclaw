import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "../agents/model-auth-markers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";

const resolveProviderUsageAuthWithPluginMock = vi.fn(async (..._args: unknown[]) => null);

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderUsageAuthWithPlugin: resolveProviderUsageAuthWithPluginMock,
}));

vi.mock("../agents/cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  readQwenCliCredentialsCached: () => null,
}));

let resolveProviderAuths: typeof import("./provider-usage.auth.js").resolveProviderAuths;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("../agents/auth-profiles.js").clearRuntimeAuthProfileStoreSnapshots;
let clearConfigCache: typeof import("../config/config.js").clearConfigCache;

describe("resolveProviderAuths key normalization", () => {
  let suiteRoot = "";
  let suiteCase = 0;
  const EMPTY_PROVIDER_ENV = {
    ZAI_API_KEY: undefined,
    Z_AI_API_KEY: undefined,
    MINIMAX_API_KEY: undefined,
    MINIMAX_CODE_PLAN_KEY: undefined,
    XIAOMI_API_KEY: undefined,
  } satisfies Record<string, string | undefined>;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-auth-suite-"));
  });

  afterAll(async () => {
    await fs.rm(suiteRoot, { recursive: true, force: true });
    suiteRoot = "";
    suiteCase = 0;
  });

  beforeEach(async () => {
    vi.resetModules();
    ({ resolveProviderAuths } = await import("./provider-usage.auth.js"));
    ({ clearRuntimeAuthProfileStoreSnapshots } = await import("../agents/auth-profiles.js"));
    ({ clearConfigCache } = await import("../config/config.js"));
    clearConfigCache();
    clearRuntimeAuthProfileStoreSnapshots();
    resolveProviderUsageAuthWithPluginMock.mockReset();
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue(null);
  });

  afterEach(() => {
    clearConfigCache();
    clearRuntimeAuthProfileStoreSnapshots();
    vi.restoreAllMocks();
  });

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const base = path.join(suiteRoot, `case-${++suiteCase}`);
    nodeFs.mkdirSync(base, { recursive: true });
    nodeFs.mkdirSync(path.join(base, ".openclaw", "agents", "main", "sessions"), {
      recursive: true,
    });
    return await fn(base);
  }

  function agentDirForHome(home: string): string {
    return path.join(home, ".openclaw", "agents", "main", "agent");
  }

  function buildSuiteEnv(
    home: string,
    env: Record<string, string | undefined> = {},
  ): NodeJS.ProcessEnv {
    const suiteEnv: NodeJS.ProcessEnv = {
      ...EMPTY_PROVIDER_ENV,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
      ...env,
    };
    const match = home.match(/^([A-Za-z]:)(.*)$/);
    if (match) {
      suiteEnv.HOMEDRIVE = match[1];
      suiteEnv.HOMEPATH = match[2] || "\\";
    }
    return suiteEnv;
  }

  async function writeAuthProfiles(home: string, profiles: Record<string, unknown>) {
    const agentDir = agentDirForHome(home);
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
    const agentDir = agentDirForHome(home);
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

  function createTestModelDefinition(): ModelDefinitionConfig {
    return {
      id: "test-model",
      name: "Test Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 256,
    };
  }

  async function resolveMinimaxAuthFromConfiguredKey(apiKey: string) {
    return await withSuiteHome(async (home) => {
      const config = {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimaxi.com",
              models: [createTestModelDefinition()],
              apiKey,
            },
          },
        },
      } satisfies OpenClawConfig;
      await writeConfig(home, config);

      return await resolveProviderAuths({
        providers: ["minimax"],
        agentDir: agentDirForHome(home),
        config,
        env: buildSuiteEnv(home),
      });
    });
  }

  async function expectResolvedAuthsFromSuiteHome(params: {
    providers: Parameters<typeof resolveProviderAuths>[0]["providers"];
    expected: Awaited<ReturnType<typeof resolveProviderAuths>>;
    env?: Record<string, string | undefined>;
    config?: OpenClawConfig;
    setup?: (home: string) => Promise<void>;
  }) {
    await withSuiteHome(async (home) => {
      if (params.setup) {
        await params.setup(home);
      }
      const config = params.config ?? {};
      const auths = await resolveProviderAuths({
        providers: params.providers,
        agentDir: agentDirForHome(home),
        config,
        env: buildSuiteEnv(home, params.env),
      });
      expect(auths).toEqual(params.expected);
    });
  }

  it("strips embedded CR/LF from env keys", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai", "minimax", "xiaomi"],
      env: {
        ZAI_API_KEY: "zai-\r\nkey",
        MINIMAX_API_KEY: "minimax-\r\nkey",
        XIAOMI_API_KEY: "xiaomi-\r\nkey",
      },
      expected: [
        { provider: "zai", token: "zai-key" },
        { provider: "minimax", token: "minimax-key" },
        { provider: "xiaomi", token: "xiaomi-key" },
      ],
    });
  }, 300_000);

  it("accepts z-ai env alias and normalizes embedded CR/LF", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      env: {
        Z_AI_API_KEY: "zai-\r\nkey",
      },
      expected: [{ provider: "zai", token: "zai-key" }],
    });
  });

  it("prefers ZAI_API_KEY over the z-ai alias when both are set", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      env: {
        ZAI_API_KEY: "direct-zai-key",
        Z_AI_API_KEY: "alias-zai-key",
      },
      expected: [{ provider: "zai", token: "direct-zai-key" }],
    });
  });

  it("prefers MINIMAX_CODE_PLAN_KEY over MINIMAX_API_KEY", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["minimax"],
      env: {
        MINIMAX_CODE_PLAN_KEY: "code-plan-key",
        MINIMAX_API_KEY: "api-key",
      },
      expected: [{ provider: "minimax", token: "code-plan-key" }],
    });
  });

  it("strips embedded CR/LF from stored auth profiles (token + api_key)", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["minimax", "xiaomi"],
      setup: async (home) => {
        await writeAuthProfiles(home, {
          "minimax:default": { type: "token", provider: "minimax", token: "mini-\r\nmax" },
          "xiaomi:default": { type: "api_key", provider: "xiaomi", key: "xiao-\r\nmi" },
        });
      },
      expected: [
        { provider: "minimax", token: "mini-max" },
        { provider: "xiaomi", token: "xiao-mi" },
      ],
    });
  });

  it("returns injected auth values unchanged", async () => {
    const auths = await resolveProviderAuths({
      providers: ["anthropic"],
      auth: [{ provider: "anthropic", token: "token-1", accountId: "acc-1" }],
    });
    expect(auths).toEqual([{ provider: "anthropic", token: "token-1", accountId: "acc-1" }]);
  });

  it("falls back to legacy .pi auth file for zai keys even after os.homedir() is primed", async () => {
    // Prime os.homedir() to simulate long-lived workers that may have touched it before HOME changes.
    os.homedir();
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      setup: async (home) => {
        await writeLegacyPiAuth(
          home,
          `${JSON.stringify({ "z-ai": { access: "legacy-zai-key" } }, null, 2)}\n`,
        );
      },
      expected: [{ provider: "zai", token: "legacy-zai-key" }],
    });
  });

  it.each([
    {
      name: "extracts google oauth token from JSON payload in token profiles",
      token: '{"token":"google-oauth-token"}',
      expectedToken: "google-oauth-token",
    },
    {
      name: "keeps raw google token when token payload is not JSON",
      token: "plain-google-token",
      expectedToken: "plain-google-token",
    },
  ])("$name", async ({ token, expectedToken }) => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["google-gemini-cli"],
      setup: async (home) => {
        await writeAuthProfiles(home, {
          "google-gemini-cli:default": {
            type: "token",
            provider: "google-gemini-cli",
            token,
          },
        });
      },
      expected: [{ provider: "google-gemini-cli", token: expectedToken }],
    });
  });

  it("uses config api keys when env and profiles are missing", async () => {
    const config = {
      models: {
        providers: {
          zai: {
            baseUrl: "https://api.z.ai",
            models: [createTestModelDefinition()],
            apiKey: "cfg-zai-key", // pragma: allowlist secret
          },
          minimax: {
            baseUrl: "https://api.minimaxi.com",
            models: [createTestModelDefinition()],
            apiKey: "cfg-minimax-key", // pragma: allowlist secret
          },
          xiaomi: {
            baseUrl: "https://api.xiaomi.example",
            models: [createTestModelDefinition()],
            apiKey: "cfg-xiaomi-key", // pragma: allowlist secret
          },
        },
      },
    } satisfies OpenClawConfig;
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai", "minimax", "xiaomi"],
      setup: async (home) => {
        await writeConfig(home, config);
      },
      config,
      expected: [
        { provider: "zai", token: "cfg-zai-key" },
        { provider: "minimax", token: "cfg-minimax-key" },
        { provider: "xiaomi", token: "cfg-xiaomi-key" },
      ],
    });
  });

  it("returns no auth when providers have no configured credentials", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai", "minimax", "xiaomi"],
      expected: [],
    });
  });

  it("uses zai api_key auth profiles when env and config are missing", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      setup: async (home) => {
        await writeAuthProfiles(home, {
          "zai:default": { type: "api_key", provider: "zai", key: "profile-zai-key" },
        });
      },
      expected: [{ provider: "zai", token: "profile-zai-key" }],
    });
  });

  it("ignores invalid legacy z-ai auth files", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      setup: async (home) => {
        await writeLegacyPiAuth(home, "{not-json");
      },
      expected: [],
    });
  });

  it("discovers oauth provider from config but skips mismatched profile providers", async () => {
    await withSuiteHome(async (home) => {
      const config = {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "token" },
          },
        },
      } satisfies OpenClawConfig;
      await writeConfig(home, config);
      await writeAuthProfiles(home, {
        "anthropic:default": {
          type: "token",
          provider: "zai",
          token: "mismatched-provider-token",
        },
      });

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        agentDir: agentDirForHome(home),
        config,
        env: buildSuiteEnv(home),
      });
      expect(auths).toEqual([]);
    });
  });

  it("skips providers without oauth-compatible profiles", async () => {
    await withSuiteHome(async (home) => {
      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        agentDir: agentDirForHome(home),
        config: {},
        env: buildSuiteEnv(home),
      });
      expect(auths).toEqual([]);
    });
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
        agentDir: agentDirForHome(home),
        config: {},
        env: buildSuiteEnv(home),
      });
      expect(auths).toEqual([{ provider: "anthropic", token: "anthropic-token" }]);
    });
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
        agentDir: agentDirForHome(home),
        config: {},
        env: buildSuiteEnv(home),
      });
      expect(auths).toEqual([{ provider: "anthropic", token: "token-1" }]);
    });
  });

  it("ignores marker-backed config keys for provider usage auth resolution", async () => {
    const auths = await resolveMinimaxAuthFromConfiguredKey(NON_ENV_SECRETREF_MARKER);
    expect(auths).toEqual([]);
  });

  it("keeps all-caps plaintext config keys eligible for provider usage auth resolution", async () => {
    const auths = await resolveMinimaxAuthFromConfiguredKey("ALLCAPS_SAMPLE");
    expect(auths).toEqual([{ provider: "minimax", token: "ALLCAPS_SAMPLE" }]);
  });
});
