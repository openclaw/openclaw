import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HyperionDynamoDBClient } from "./dynamodb-client.js";
import { HyperionPairingStore } from "./pairing-store.js";
import { DEFAULT_AGENT_ID } from "./types.js";

function createMockDbClient() {
  return {
    putPairingCode: vi.fn(),
    getPairingCode: vi.fn(),
    consumePairingCode: vi.fn(),
    deletePairingCode: vi.fn(),
    putChannelLink: vi.fn(),
    deleteChannelLink: vi.fn(),
  } as unknown as HyperionDynamoDBClient & {
    putPairingCode: ReturnType<typeof vi.fn>;
    getPairingCode: ReturnType<typeof vi.fn>;
    consumePairingCode: ReturnType<typeof vi.fn>;
    deletePairingCode: ReturnType<typeof vi.fn>;
    putChannelLink: ReturnType<typeof vi.fn>;
    deleteChannelLink: ReturnType<typeof vi.fn>;
  };
}

describe("HyperionPairingStore", () => {
  let dbClient: ReturnType<typeof createMockDbClient>;
  let store: HyperionPairingStore;

  beforeEach(() => {
    dbClient = createMockDbClient();
    store = new HyperionPairingStore(dbClient);
  });

  describe("generatePairingCode", () => {
    it("returns a code on success", async () => {
      dbClient.putPairingCode.mockResolvedValueOnce(undefined);

      const code = await store.generatePairingCode("user-1", "telegram");

      expect(code).toBeTruthy();
      expect(typeof code).toBe("string");
      expect(code!.length).toBe(8);
      expect(dbClient.putPairingCode).toHaveBeenCalledOnce();
      const savedCode = dbClient.putPairingCode.mock.calls[0][0];
      expect(savedCode.user_id).toBe("user-1");
      expect(savedCode.platform).toBe("telegram");
      expect(savedCode.agent_id).toBe(DEFAULT_AGENT_ID);
    });

    it("retries on ConditionalCheckFailedException", async () => {
      const conditionalError = new Error("Conditional check failed");
      conditionalError.name = "ConditionalCheckFailedException";

      dbClient.putPairingCode
        .mockRejectedValueOnce(conditionalError)
        .mockRejectedValueOnce(conditionalError)
        .mockResolvedValueOnce(undefined);

      const code = await store.generatePairingCode("user-1", "telegram");

      expect(code).toBeTruthy();
      expect(dbClient.putPairingCode).toHaveBeenCalledTimes(3);
    });

    it("returns null after 5 failed attempts", async () => {
      const conditionalError = new Error("Conditional check failed");
      conditionalError.name = "ConditionalCheckFailedException";

      dbClient.putPairingCode.mockRejectedValue(conditionalError);

      const code = await store.generatePairingCode("user-1", "telegram");

      expect(code).toBeNull();
      expect(dbClient.putPairingCode).toHaveBeenCalledTimes(5);
    });

    it("passes agentId through to PairingCode", async () => {
      dbClient.putPairingCode.mockResolvedValueOnce(undefined);

      const code = await store.generatePairingCode("user-1", "slack", "work-agent");

      expect(code).toBeTruthy();
      const savedCode = dbClient.putPairingCode.mock.calls[0][0];
      expect(savedCode.agent_id).toBe("work-agent");
    });

    it("throws on non-conditional errors", async () => {
      const genericError = new Error("DynamoDB is down");
      genericError.name = "InternalServerError";

      dbClient.putPairingCode.mockRejectedValueOnce(genericError);

      await expect(store.generatePairingCode("user-1", "telegram")).rejects.toThrow(
        "DynamoDB is down",
      );
      expect(dbClient.putPairingCode).toHaveBeenCalledOnce();
    });
  });

  describe("redeemPairingCode", () => {
    const basePairingCode = {
      code: "ABCD1234",
      user_id: "user-1",
      agent_id: "work-agent",
      platform: "telegram" as const,
      created_at: "2026-01-01T00:00:00.000Z",
      expires_at: Math.floor(Date.now() / 1000) + 300,
    };

    it("creates ChannelLink with correct data, inherits agent_id from pairing code", async () => {
      dbClient.consumePairingCode.mockResolvedValueOnce(basePairingCode);
      dbClient.putChannelLink.mockResolvedValueOnce(undefined);

      const link = await store.redeemPairingCode({
        code: "ABCD1234",
        platform: "telegram",
        platformUserId: "tg-user-99",
        channelAccountId: "bot-account",
        channelConfig: { some: "config" },
      });

      expect(link).not.toBeNull();
      expect(link!.platform).toBe("telegram");
      expect(link!.platform_user_id).toBe("tg-user-99");
      expect(link!.user_id).toBe("user-1");
      expect(link!.agent_id).toBe("work-agent");
      expect(link!.channel_account_id).toBe("bot-account");
      expect(link!.channel_config).toEqual({ some: "config" });
      expect(link!.paired_at).toBeTruthy();
      expect(dbClient.putChannelLink).toHaveBeenCalledOnce();
    });

    it("normalizes code to uppercase", async () => {
      dbClient.consumePairingCode.mockResolvedValueOnce(basePairingCode);
      dbClient.putChannelLink.mockResolvedValueOnce(undefined);

      await store.redeemPairingCode({
        code: "  abcd1234  ",
        platform: "telegram",
        platformUserId: "tg-user-99",
      });

      expect(dbClient.consumePairingCode).toHaveBeenCalledWith("ABCD1234");
    });

    it("returns null for empty code", async () => {
      const link = await store.redeemPairingCode({
        code: "   ",
        platform: "telegram",
        platformUserId: "tg-user-99",
      });

      expect(link).toBeNull();
      expect(dbClient.getPairingCode).not.toHaveBeenCalled();
    });

    it("returns null if pairing code not found (already consumed)", async () => {
      dbClient.consumePairingCode.mockResolvedValueOnce(null);

      const link = await store.redeemPairingCode({
        code: "NONEXIST",
        platform: "telegram",
        platformUserId: "tg-user-99",
      });

      expect(link).toBeNull();
      expect(dbClient.putChannelLink).not.toHaveBeenCalled();
    });

    it("returns null if platform doesn't match", async () => {
      dbClient.consumePairingCode.mockResolvedValueOnce(basePairingCode);

      const link = await store.redeemPairingCode({
        code: "ABCD1234",
        platform: "slack",
        platformUserId: "slack-user-1",
      });

      expect(link).toBeNull();
      expect(dbClient.putChannelLink).not.toHaveBeenCalled();
    });
  });

  describe("validatePairingCode", () => {
    it("returns pairing code when valid", async () => {
      const pairingCode = {
        code: "ABCD1234",
        user_id: "user-1",
        agent_id: DEFAULT_AGENT_ID,
        platform: "telegram" as const,
        created_at: "2026-01-01T00:00:00.000Z",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      };
      dbClient.getPairingCode.mockResolvedValueOnce(pairingCode);

      const result = await store.validatePairingCode("abcd1234", "telegram");

      expect(result).toEqual(pairingCode);
      expect(dbClient.getPairingCode).toHaveBeenCalledWith("ABCD1234");
    });

    it("returns null on platform mismatch", async () => {
      const pairingCode = {
        code: "ABCD1234",
        user_id: "user-1",
        agent_id: DEFAULT_AGENT_ID,
        platform: "telegram" as const,
        created_at: "2026-01-01T00:00:00.000Z",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      };
      dbClient.getPairingCode.mockResolvedValueOnce(pairingCode);

      const result = await store.validatePairingCode("ABCD1234", "discord");

      expect(result).toBeNull();
    });
  });

  describe("disconnectChannel", () => {
    it("calls deleteChannelLink", async () => {
      dbClient.deleteChannelLink.mockResolvedValueOnce(undefined);

      await store.disconnectChannel("telegram", "tg-user-99");

      expect(dbClient.deleteChannelLink).toHaveBeenCalledWith("telegram", "tg-user-99");
    });
  });
});
