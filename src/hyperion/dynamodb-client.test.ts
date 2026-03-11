// @vitest-pool threads
// ↑ vi.mock for dynamic `await import()` requires threads pool (forks doesn't intercept).
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock AWS SDK commands — the source uses dynamic imports which fail without the package installed.
// Each command class just stores its input for assertion.
class MockCommand {
  input: unknown;
  constructor(input: unknown) {
    this.input = input;
  }
}
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  GetCommand: class extends MockCommand {},
  PutCommand: class extends MockCommand {},
  DeleteCommand: class extends MockCommand {},
  QueryCommand: class extends MockCommand {},
}));

import { HyperionDynamoDBClient, type DynamoDBDocClient } from "./dynamodb-client.js";
import type {
  HyperionDynamoDBConfig,
  TenantConfig,
  PairingCode,
  UserCredentialsRecord,
} from "./types.js";
import { DEFAULT_AGENT_ID } from "./types.js";

const TEST_CONFIG: HyperionDynamoDBConfig = {
  region: "us-west-2",
  tenantConfigTableName: "hyperion-test-tenant-config",
  channelConfigTableName: "hyperion-test-channel-config",
  pairingCodesTableName: "hyperion-test-pairing-codes",
  userCredentialsTableName: "hyperion-test-user-credentials",
  credentialsKmsKeyId: "arn:aws:kms:us-west-2:123456789012:key/test-key-id",
  channelConfigUserIdIndexName: "user-id-index",
};

function createMockDocClient(): DynamoDBDocClient & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

describe("HyperionDynamoDBClient", () => {
  let mockDocClient: ReturnType<typeof createMockDocClient>;
  let client: HyperionDynamoDBClient;

  beforeEach(() => {
    mockDocClient = createMockDocClient();
    client = new HyperionDynamoDBClient(TEST_CONFIG, mockDocClient);
  });

  // -- getTenantConfig --

  describe("getTenantConfig", () => {
    it("returns the item when found", async () => {
      const tenantConfig: TenantConfig = {
        user_id: "user-1",
        agent_id: "main",
        display_name: "Test User",
        plan: "pro",
      };
      mockDocClient.send.mockResolvedValueOnce({ Item: tenantConfig });

      const result = await client.getTenantConfig("user-1");

      expect(result).toEqual(tenantConfig);
      expect(mockDocClient.send).toHaveBeenCalledOnce();
    });

    it("returns null when item is not found", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      const result = await client.getTenantConfig("nonexistent-user");

      expect(result).toBeNull();
    });

    it("uses the correct table name and composite key", async () => {
      mockDocClient.send.mockResolvedValueOnce({ Item: { user_id: "u1", agent_id: "helper" } });

      await client.getTenantConfig("u1", "helper");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input).toEqual({
        TableName: "hyperion-test-tenant-config",
        Key: { user_id: "u1", agent_id: "helper" },
      });
    });

    it("defaults agentId to DEFAULT_AGENT_ID when not provided", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.getTenantConfig("u1");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.Key).toEqual({ user_id: "u1", agent_id: DEFAULT_AGENT_ID });
    });
  });

  // -- listTenantAgents --

  describe("listTenantAgents", () => {
    it("returns items array from query", async () => {
      const agents: TenantConfig[] = [
        { user_id: "u1", agent_id: "main" },
        { user_id: "u1", agent_id: "work" },
      ];
      mockDocClient.send.mockResolvedValueOnce({ Items: agents });

      const result = await client.listTenantAgents("u1");

      expect(result).toEqual(agents);
      expect(result).toHaveLength(2);
    });

    it("returns empty array when no items found", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      const result = await client.listTenantAgents("u1");

      expect(result).toEqual([]);
    });

    it("queries the correct table with user_id", async () => {
      mockDocClient.send.mockResolvedValueOnce({ Items: [] });

      await client.listTenantAgents("u1");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input).toEqual({
        TableName: "hyperion-test-tenant-config",
        KeyConditionExpression: "user_id = :uid",
        ExpressionAttributeValues: { ":uid": "u1" },
      });
    });
  });

  // -- putTenantConfig --

  describe("putTenantConfig", () => {
    it("sets updated_at timestamp", async () => {
      mockDocClient.send.mockResolvedValueOnce({});
      const before = new Date().toISOString();

      await client.putTenantConfig({ user_id: "u1", agent_id: "main" });

      const command = mockDocClient.send.mock.calls[0][0];
      const item = command.input.Item;
      expect(item.updated_at).toBeDefined();
      // updated_at should be a recent ISO timestamp
      const updatedAt = new Date(item.updated_at).getTime();
      expect(updatedAt).toBeGreaterThanOrEqual(new Date(before).getTime());
      expect(updatedAt).toBeLessThanOrEqual(Date.now());
    });

    it("defaults agent_id to DEFAULT_AGENT_ID when falsy", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.putTenantConfig({ user_id: "u1", agent_id: "" });

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.Item.agent_id).toBe(DEFAULT_AGENT_ID);
    });

    it("preserves explicit agent_id", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.putTenantConfig({ user_id: "u1", agent_id: "work-helper" });

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.Item.agent_id).toBe("work-helper");
    });

    it("writes to the correct table", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.putTenantConfig({ user_id: "u1", agent_id: "main" });

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.TableName).toBe("hyperion-test-tenant-config");
    });
  });

  // -- deleteTenantConfig --

  describe("deleteTenantConfig", () => {
    it("deletes with correct key", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.deleteTenantConfig("u1", "work");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input).toEqual({
        TableName: "hyperion-test-tenant-config",
        Key: { user_id: "u1", agent_id: "work" },
      });
    });

    it("defaults agentId to DEFAULT_AGENT_ID", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.deleteTenantConfig("u1");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.Key).toEqual({ user_id: "u1", agent_id: DEFAULT_AGENT_ID });
    });
  });

  // -- getChannelLink --

  describe("getChannelLink", () => {
    it("returns channel link when found", async () => {
      const link = {
        platform: "telegram" as const,
        platform_user_id: "tg-123",
        user_id: "u1",
        agent_id: "main",
        paired_at: "2025-01-01T00:00:00Z",
        channel_account_id: "bot-1",
        channel_config: {},
      };
      mockDocClient.send.mockResolvedValueOnce({ Item: link });

      const result = await client.getChannelLink("telegram", "tg-123");

      expect(result).toEqual(link);
    });

    it("returns null when not found", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      const result = await client.getChannelLink("slack", "unknown");

      expect(result).toBeNull();
    });

    it("uses correct table and composite key", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.getChannelLink("discord", "disc-456");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input).toEqual({
        TableName: "hyperion-test-channel-config",
        Key: { platform: "discord", platform_user_id: "disc-456" },
      });
    });
  });

  // -- getChannelLinksForUser --

  describe("getChannelLinksForUser", () => {
    it("queries GSI with correct index name", async () => {
      mockDocClient.send.mockResolvedValueOnce({ Items: [] });

      await client.getChannelLinksForUser("u1");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input).toEqual({
        TableName: "hyperion-test-channel-config",
        IndexName: "user-id-index",
        KeyConditionExpression: "user_id = :uid",
        ExpressionAttributeValues: { ":uid": "u1" },
      });
    });

    it("returns empty array when no links found", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      const result = await client.getChannelLinksForUser("u1");

      expect(result).toEqual([]);
    });
  });

  // -- putChannelLink --

  describe("putChannelLink", () => {
    it("writes channel link to correct table", async () => {
      mockDocClient.send.mockResolvedValueOnce({});
      const link = {
        platform: "telegram" as const,
        platform_user_id: "tg-123",
        user_id: "u1",
        agent_id: "main",
        paired_at: "2025-01-01T00:00:00Z",
        channel_account_id: "bot-1",
        channel_config: {},
      };

      await client.putChannelLink(link);

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.TableName).toBe("hyperion-test-channel-config");
      expect(command.input.Item).toEqual(link);
    });
  });

  // -- deleteChannelLink --

  describe("deleteChannelLink", () => {
    it("deletes with correct key", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.deleteChannelLink("whatsapp", "wa-789");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input).toEqual({
        TableName: "hyperion-test-channel-config",
        Key: { platform: "whatsapp", platform_user_id: "wa-789" },
      });
    });
  });

  // -- getPairingCode --

  describe("getPairingCode", () => {
    it("returns code when not expired", async () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 300; // 5 min from now
      const pairingCode: PairingCode = {
        code: "ABC123",
        user_id: "u1",
        agent_id: "main",
        platform: "telegram",
        created_at: "2025-01-01T00:00:00Z",
        expires_at: futureExpiry,
      };
      mockDocClient.send.mockResolvedValueOnce({ Item: pairingCode });

      const result = await client.getPairingCode("ABC123");

      expect(result).toEqual(pairingCode);
    });

    it("returns null for expired codes", async () => {
      const pastExpiry = Math.floor(Date.now() / 1000) - 60; // 1 min ago
      const pairingCode: PairingCode = {
        code: "EXPIRED1",
        user_id: "u1",
        agent_id: "main",
        platform: "telegram",
        created_at: "2025-01-01T00:00:00Z",
        expires_at: pastExpiry,
      };
      mockDocClient.send.mockResolvedValueOnce({ Item: pairingCode });

      const result = await client.getPairingCode("EXPIRED1");

      expect(result).toBeNull();
    });

    it("returns null when code not found in DynamoDB", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      const result = await client.getPairingCode("NONEXIST");

      expect(result).toBeNull();
    });

    it("uses correct table and key", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.getPairingCode("CODE1");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input).toEqual({
        TableName: "hyperion-test-pairing-codes",
        Key: { code: "CODE1" },
      });
    });
  });

  // -- putPairingCode --

  describe("putPairingCode", () => {
    it("writes with ConditionExpression to prevent overwrites", async () => {
      mockDocClient.send.mockResolvedValueOnce({});
      const pairingCode: PairingCode = {
        code: "NEW123",
        user_id: "u1",
        agent_id: "main",
        platform: "slack",
        created_at: "2025-01-01T00:00:00Z",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      };

      await client.putPairingCode(pairingCode);

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.TableName).toBe("hyperion-test-pairing-codes");
      expect(command.input.Item).toEqual(pairingCode);
      expect(command.input.ConditionExpression).toBe("attribute_not_exists(code)");
    });
  });

  // -- deletePairingCode --

  describe("deletePairingCode", () => {
    it("deletes with correct key", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.deletePairingCode("CODE1");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input).toEqual({
        TableName: "hyperion-test-pairing-codes",
        Key: { code: "CODE1" },
      });
    });
  });

  // -- getUserCredentials --

  describe("getUserCredentials", () => {
    const credRecord: UserCredentialsRecord = {
      user_id: "u1",
      agent_id: "work",
      credentials_blob: "encrypted-blob",
      kms_key_id: "key-1",
      updated_at: "2025-01-01T00:00:00Z",
    };

    it("returns agent-specific credentials when found", async () => {
      mockDocClient.send.mockResolvedValueOnce({ Item: credRecord });

      const result = await client.getUserCredentials("u1", "work");

      expect(result).toEqual(credRecord);
      // Should only call send once (no fallback needed)
      expect(mockDocClient.send).toHaveBeenCalledOnce();
    });

    it("falls back to __shared__ when agent-specific not found", async () => {
      const sharedRecord: UserCredentialsRecord = {
        user_id: "u1",
        agent_id: "__shared__",
        credentials_blob: "shared-blob",
        kms_key_id: "key-1",
        updated_at: "2025-01-01T00:00:00Z",
      };
      // First call: agent-specific not found
      mockDocClient.send.mockResolvedValueOnce({});
      // Second call: __shared__ found
      mockDocClient.send.mockResolvedValueOnce({ Item: sharedRecord });

      const result = await client.getUserCredentials("u1", "work");

      expect(result).toEqual(sharedRecord);
      expect(mockDocClient.send).toHaveBeenCalledTimes(2);

      // Verify first call was for agent-specific
      const firstCommand = mockDocClient.send.mock.calls[0][0];
      expect(firstCommand.input.Key).toEqual({ user_id: "u1", agent_id: "work" });

      // Verify second call was for __shared__
      const secondCommand = mockDocClient.send.mock.calls[1][0];
      expect(secondCommand.input.Key).toEqual({ user_id: "u1", agent_id: "__shared__" });
    });

    it("returns null when neither agent-specific nor __shared__ found", async () => {
      mockDocClient.send.mockResolvedValueOnce({});
      mockDocClient.send.mockResolvedValueOnce({});

      const result = await client.getUserCredentials("u1", "work");

      expect(result).toBeNull();
      expect(mockDocClient.send).toHaveBeenCalledTimes(2);
    });

    it("does NOT fall back when agentId is already __shared__", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      const result = await client.getUserCredentials("u1", "__shared__");

      expect(result).toBeNull();
      // Should only call send once — no fallback to __shared__ when already querying __shared__
      expect(mockDocClient.send).toHaveBeenCalledOnce();
    });

    it("defaults agentId to DEFAULT_AGENT_ID", async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: { ...credRecord, agent_id: DEFAULT_AGENT_ID },
      });

      await client.getUserCredentials("u1");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.Key).toEqual({ user_id: "u1", agent_id: DEFAULT_AGENT_ID });
    });

    it("uses the correct table for all calls", async () => {
      mockDocClient.send.mockResolvedValueOnce({});
      mockDocClient.send.mockResolvedValueOnce({});

      await client.getUserCredentials("u1", "custom-agent");

      const firstCommand = mockDocClient.send.mock.calls[0][0];
      const secondCommand = mockDocClient.send.mock.calls[1][0];
      expect(firstCommand.input.TableName).toBe("hyperion-test-user-credentials");
      expect(secondCommand.input.TableName).toBe("hyperion-test-user-credentials");
    });
  });

  // -- putUserCredentials --

  describe("putUserCredentials", () => {
    it("defaults agent_id when falsy", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.putUserCredentials({
        user_id: "u1",
        agent_id: "",
        credentials_blob: "blob",
        kms_key_id: "key-1",
        updated_at: "2025-01-01T00:00:00Z",
      });

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.Item.agent_id).toBe(DEFAULT_AGENT_ID);
    });

    it("preserves explicit agent_id", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.putUserCredentials({
        user_id: "u1",
        agent_id: "custom",
        credentials_blob: "blob",
        kms_key_id: "key-1",
        updated_at: "2025-01-01T00:00:00Z",
      });

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.Item.agent_id).toBe("custom");
    });

    it("writes to the correct table", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.putUserCredentials({
        user_id: "u1",
        agent_id: "main",
        credentials_blob: "blob",
        kms_key_id: "key-1",
        updated_at: "2025-01-01T00:00:00Z",
      });

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.TableName).toBe("hyperion-test-user-credentials");
    });
  });

  // -- deleteUserCredentials --

  describe("deleteUserCredentials", () => {
    it("deletes with correct key", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.deleteUserCredentials("u1", "work");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input).toEqual({
        TableName: "hyperion-test-user-credentials",
        Key: { user_id: "u1", agent_id: "work" },
      });
    });

    it("defaults agentId to DEFAULT_AGENT_ID", async () => {
      mockDocClient.send.mockResolvedValueOnce({});

      await client.deleteUserCredentials("u1");

      const command = mockDocClient.send.mock.calls[0][0];
      expect(command.input.Key).toEqual({ user_id: "u1", agent_id: DEFAULT_AGENT_ID });
    });
  });
});
