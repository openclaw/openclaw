import { beforeEach, describe, expect, test, vi } from "vitest";
import type { HyperionDynamoDBClient } from "./dynamodb-client.js";
import { TenantConfigLoader, TenantNotFoundError } from "./tenant-config-loader.js";
import type { ChannelLink, TenantConfig } from "./types.js";
import type { UserCredentialStore } from "./user-credential-store.js";

function createMockFns() {
  return {
    getTenantConfig: vi.fn(),
    listTenantAgents: vi.fn(),
    putTenantConfig: vi.fn(),
    deleteTenantConfig: vi.fn(),
    getChannelLink: vi.fn(),
    getChannelLinksForUser: vi.fn(),
    putChannelLink: vi.fn(),
    deleteChannelLink: vi.fn(),
    getPairingCode: vi.fn(),
    putPairingCode: vi.fn(),
    deletePairingCode: vi.fn(),
    getUserCredentials: vi.fn(),
    putUserCredentials: vi.fn(),
    deleteUserCredentials: vi.fn(),
  };
}

function createMockCredFns() {
  return {
    getCredentials: vi.fn(),
    putCredentials: vi.fn(),
    deleteCredentials: vi.fn(),
    invalidateCache: vi.fn(),
    clearCache: vi.fn(),
  };
}

const baseTenantConfig: TenantConfig = {
  user_id: "user1",
  agent_id: "main",
  model: "anthropic.claude-sonnet-4-20250514",
  custom_instructions: "Be helpful",
  tools: ["brave_search", "calculator"],
  skills: ["web"],
};

const channelLink: ChannelLink = {
  platform: "telegram",
  platform_user_id: "tg98765",
  user_id: "user1",
  agent_id: "main",
  paired_at: "2026-01-01T00:00:00.000Z",
  channel_account_id: "bot1",
  channel_config: { streaming: "partial" },
};

describe("TenantConfigLoader", () => {
  let mockDb: ReturnType<typeof createMockFns>;
  let mockCreds: ReturnType<typeof createMockCredFns>;
  let loader: TenantConfigLoader;

  beforeEach(() => {
    mockDb = createMockFns();
    mockCreds = createMockCredFns();
    loader = new TenantConfigLoader(
      mockDb as unknown as HyperionDynamoDBClient,
      {},
      mockCreds as unknown as UserCredentialStore,
    );
  });

  // -- loadTenantConfig --

  describe("loadTenantConfig", () => {
    test("builds config from DynamoDB data", async () => {
      mockDb.getTenantConfig.mockResolvedValue(baseTenantConfig);
      mockDb.getChannelLinksForUser.mockResolvedValue([channelLink]);
      mockCreds.getCredentials.mockResolvedValue(null);

      const config = await loader.loadTenantConfig("user1");

      expect(config).toHaveProperty(
        "agents.list.0.model.primary",
        "anthropic.claude-sonnet-4-20250514",
      );
      expect(config).toHaveProperty("tools.allow", ["brave_search", "calculator"]);
      expect(config).toHaveProperty("channels.telegram");
      expect(config).toHaveProperty("channels.telegram.enabled", true);
    });

    test("throws TenantNotFoundError when config missing", async () => {
      mockDb.getTenantConfig.mockResolvedValue(null);
      mockDb.getChannelLinksForUser.mockResolvedValue([]);
      mockCreds.getCredentials.mockResolvedValue(null);

      await expect(loader.loadTenantConfig("nonexistent")).rejects.toThrow(TenantNotFoundError);
    });

    test("filters channel links by agentId", async () => {
      const workLink: ChannelLink = { ...channelLink, agent_id: "work" };
      const mainLink: ChannelLink = {
        ...channelLink,
        platform_user_id: "tg11111",
        agent_id: "main",
      };

      mockDb.getTenantConfig.mockResolvedValue(baseTenantConfig);
      mockDb.getChannelLinksForUser.mockResolvedValue([workLink, mainLink]);
      mockCreds.getCredentials.mockResolvedValue(null);

      const config = await loader.loadTenantConfig("user1", "main");

      // Only mainLink should be included (filtered to agent_id=main)
      expect(config).toHaveProperty("channels.telegram");
      const plain = JSON.parse(JSON.stringify(config));
      const accountKeys = Object.keys(plain.channels.telegram.accounts);
      expect(accountKeys).toHaveLength(1);
      // The account's allowFrom should reference mainLink's platform_user_id
      expect(plain.channels.telegram.accounts[accountKeys[0]].allowFrom).toEqual(["tg11111"]);
    });

    test("injects model_keys from credentials", async () => {
      mockDb.getTenantConfig.mockResolvedValue(baseTenantConfig);
      mockDb.getChannelLinksForUser.mockResolvedValue([]);
      mockCreds.getCredentials.mockResolvedValue({
        model_keys: { openai: "sk-test123" },
      });

      const config = await loader.loadTenantConfig("user1");
      expect(config).toHaveProperty("models.providers.openai.apiKey", "sk-test123");
    });

    test("injects channel_tokens into channel accounts", async () => {
      mockDb.getTenantConfig.mockResolvedValue(baseTenantConfig);
      mockDb.getChannelLinksForUser.mockResolvedValue([channelLink]);
      mockCreds.getCredentials.mockResolvedValue({
        channel_tokens: { telegram: "bot-token-123" },
      });

      const config = await loader.loadTenantConfig("user1");
      expect(config).toHaveProperty("channels.telegram.accounts");
      const plain = JSON.parse(JSON.stringify(config));
      expect(Object.values(plain.channels.telegram.accounts)[0]).toHaveProperty(
        "botToken",
        "bot-token-123",
      );
    });
  });

  // -- caching --

  describe("caching", () => {
    test("returns cached config on second call", async () => {
      mockDb.getTenantConfig.mockResolvedValue(baseTenantConfig);
      mockDb.getChannelLinksForUser.mockResolvedValue([]);
      mockCreds.getCredentials.mockResolvedValue(null);

      const config1 = await loader.loadTenantConfig("user1");
      const config2 = await loader.loadTenantConfig("user1");

      expect(config1).toBe(config2); // same reference
      expect(mockDb.getTenantConfig).toHaveBeenCalledTimes(1);
    });

    test("separate cache keys for different agents", async () => {
      const workConfig = { ...baseTenantConfig, agent_id: "work", model: "gpt-4" };
      mockDb.getTenantConfig
        .mockResolvedValueOnce(baseTenantConfig)
        .mockResolvedValueOnce(workConfig);
      mockDb.getChannelLinksForUser.mockResolvedValue([]);
      mockCreds.getCredentials.mockResolvedValue(null);

      const main = await loader.loadTenantConfig("user1", "main");
      const work = await loader.loadTenantConfig("user1", "work");

      expect(main).toHaveProperty(
        "agents.list.0.model.primary",
        "anthropic.claude-sonnet-4-20250514",
      );
      expect(work).toHaveProperty("agents.list.0.model.primary", "gpt-4");
      expect(mockDb.getTenantConfig).toHaveBeenCalledTimes(2);
    });

    test("invalidateCache forces refetch", async () => {
      mockDb.getTenantConfig.mockResolvedValue(baseTenantConfig);
      mockDb.getChannelLinksForUser.mockResolvedValue([]);
      mockCreds.getCredentials.mockResolvedValue(null);

      await loader.loadTenantConfig("user1");
      loader.invalidateCache("user1");
      await loader.loadTenantConfig("user1");

      expect(mockDb.getTenantConfig).toHaveBeenCalledTimes(2);
    });

    test("clearCache empties all entries", async () => {
      mockDb.getTenantConfig.mockResolvedValue(baseTenantConfig);
      mockDb.getChannelLinksForUser.mockResolvedValue([]);
      mockCreds.getCredentials.mockResolvedValue(null);

      await loader.loadTenantConfig("user1");
      await loader.loadTenantConfig("user2");
      loader.clearCache();
      await loader.loadTenantConfig("user1");

      // getTenantConfig called 3 times: user1, user2, user1 (after clear)
      expect(mockDb.getTenantConfig).toHaveBeenCalledTimes(3);
    });
  });

  // -- custom_instructions / profile merging --

  describe("agent config merging", () => {
    test("applies custom_instructions to agents config", async () => {
      mockDb.getTenantConfig.mockResolvedValue({
        ...baseTenantConfig,
        custom_instructions: "Always respond in French",
      });
      mockDb.getChannelLinksForUser.mockResolvedValue([]);
      mockCreds.getCredentials.mockResolvedValue(null);

      const config = await loader.loadTenantConfig("user1");
      expect(config).toHaveProperty("agents.list.0.customInstructions", "Always respond in French");
    });

    test("applies profile settings to agents config", async () => {
      mockDb.getTenantConfig.mockResolvedValue({
        ...baseTenantConfig,
        profile: { name: "TestBot", avatar: "robot" },
      });
      mockDb.getChannelLinksForUser.mockResolvedValue([]);
      mockCreds.getCredentials.mockResolvedValue(null);

      const config = await loader.loadTenantConfig("user1");
      expect(config).toHaveProperty("agents.list.0.name", "TestBot");
      expect(config).toHaveProperty("agents.list.0.avatar", "robot");
    });
  });

  // -- TenantNotFoundError --

  describe("TenantNotFoundError", () => {
    test("has correct name and tenantId", () => {
      const err = new TenantNotFoundError("user999");
      expect(err.name).toBe("TenantNotFoundError");
      expect(err.tenantId).toBe("user999");
      expect(err.message).toBe("Tenant not found: user999");
      expect(err).toBeInstanceOf(Error);
    });
  });
});
