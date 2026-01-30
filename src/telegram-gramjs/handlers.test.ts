/**
 * Tests for Telegram GramJS message handlers.
 */

import { describe, expect, it, vi } from "vitest";
import {
  convertToMsgContext,
  extractSenderInfo,
  buildSessionKey,
  extractCommand,
} from "./handlers.js";
import type { GramJSMessageContext, ResolvedGramJSAccount } from "./types.js";

// Mock logger
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

// Helper to create mock GramJS message context
function createMockMessage(overrides: Partial<GramJSMessageContext> = {}): GramJSMessageContext {
  return {
    messageId: 12345,
    chatId: 67890,
    senderId: 11111,
    text: "Hello, world!",
    date: Math.floor(Date.now() / 1000),
    isGroup: false,
    isChannel: false,
    senderUsername: "testuser",
    senderFirstName: "Test",
    ...overrides,
  };
}

// Helper to create mock resolved account
function createMockAccount(overrides: Partial<ResolvedGramJSAccount> = {}): ResolvedGramJSAccount {
  return {
    accountId: "test-account",
    config: {
      apiId: 123456,
      apiHash: "test_hash",
      phoneNumber: "+12025551234",
      enabled: true,
      ...overrides.config,
    },
    ...overrides,
  } as ResolvedGramJSAccount;
}

describe("convertToMsgContext", () => {
  it("should convert DM message correctly", async () => {
    const gramjsMessage = createMockMessage({
      text: "Hello from DM",
      senderId: 11111,
      chatId: 11111, // In DMs, chatId = senderId
      senderUsername: "alice",
      senderFirstName: "Alice",
    });

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeDefined();
    expect(result!.Body).toBe("Hello from DM");
    expect(result!.From).toBe("@alice");
    expect(result!.SenderId).toBe("11111");
    expect(result!.SenderUsername).toBe("alice");
    expect(result!.SenderName).toBe("Alice");
    expect(result!.ChatType).toBe("direct");
    expect(result!.SessionKey).toBe("telegram-gramjs:test-account:11111");
    expect(result!.Provider).toBe("telegram-gramjs");
  });

  it("should convert group message correctly", async () => {
    const gramjsMessage = createMockMessage({
      text: "Hello from group",
      senderId: 11111,
      chatId: 99999,
      isGroup: true,
      chatTitle: "Test Group",
      senderUsername: "bob",
      senderFirstName: "Bob",
    });

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeDefined();
    expect(result!.Body).toBe("Hello from group");
    expect(result!.ChatType).toBe("group");
    expect(result!.GroupId).toBe("99999");
    expect(result!.GroupSubject).toBe("Test Group");
    expect(result!.SessionKey).toBe("telegram-gramjs:test-account:group:99999");
  });

  it("should handle reply context", async () => {
    const gramjsMessage = createMockMessage({
      text: "This is a reply",
      messageId: 12345,
      chatId: 67890,
      replyToId: 11111,
    });

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeDefined();
    expect(result!.ReplyToId).toBe("11111");
    expect(result!.ReplyToIdFull).toBe("67890:11111");
  });

  it("should skip channel messages", async () => {
    const gramjsMessage = createMockMessage({
      text: "Channel post",
      isChannel: true,
    });

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeNull();
  });

  it("should skip empty messages", async () => {
    const gramjsMessage = createMockMessage({
      text: "",
    });

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeNull();
  });

  it("should skip whitespace-only messages", async () => {
    const gramjsMessage = createMockMessage({
      text: "   \n\t   ",
    });

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeNull();
  });

  it("should use user ID as fallback for From when no username", async () => {
    const gramjsMessage = createMockMessage({
      text: "Hello",
      senderId: 11111,
      senderUsername: undefined,
    });

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeDefined();
    expect(result!.From).toBe("11111"); // No @ prefix when using ID
  });

  it("should convert timestamps correctly", async () => {
    const unixTimestamp = 1706640000; // Some timestamp
    const gramjsMessage = createMockMessage({
      date: unixTimestamp,
    });

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeDefined();
    expect(result!.Timestamp).toBe(unixTimestamp * 1000); // Should convert to milliseconds
  });

  it("should populate all required MsgContext fields", async () => {
    const gramjsMessage = createMockMessage({
      text: "Test message",
      messageId: 12345,
      chatId: 67890,
      senderId: 11111,
    });

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeDefined();

    // Check all required fields are present
    expect(result!.Body).toBeDefined();
    expect(result!.RawBody).toBeDefined();
    expect(result!.CommandBody).toBeDefined();
    expect(result!.BodyForAgent).toBeDefined();
    expect(result!.BodyForCommands).toBeDefined();
    expect(result!.From).toBeDefined();
    expect(result!.To).toBeDefined();
    expect(result!.SessionKey).toBeDefined();
    expect(result!.AccountId).toBeDefined();
    expect(result!.MessageSid).toBeDefined();
    expect(result!.MessageSidFull).toBeDefined();
    expect(result!.Timestamp).toBeDefined();
    expect(result!.ChatType).toBeDefined();
    expect(result!.ChatId).toBeDefined();
    expect(result!.Provider).toBeDefined();
    expect(result!.Surface).toBeDefined();
  });
});

describe("extractSenderInfo", () => {
  it("should extract sender info with username", () => {
    const gramjsMessage = createMockMessage({
      senderId: 11111,
      senderUsername: "alice",
      senderFirstName: "Alice",
    });

    const result = extractSenderInfo(gramjsMessage);

    expect(result.senderId).toBe("11111");
    expect(result.senderUsername).toBe("alice");
    expect(result.senderName).toBe("Alice");
  });

  it("should fallback to username for name if no firstName", () => {
    const gramjsMessage = createMockMessage({
      senderId: 11111,
      senderUsername: "alice",
      senderFirstName: undefined,
    });

    const result = extractSenderInfo(gramjsMessage);

    expect(result.senderName).toBe("alice");
  });

  it("should fallback to ID if no username or firstName", () => {
    const gramjsMessage = createMockMessage({
      senderId: 11111,
      senderUsername: undefined,
      senderFirstName: undefined,
    });

    const result = extractSenderInfo(gramjsMessage);

    expect(result.senderName).toBe("11111");
  });
});

describe("buildSessionKey", () => {
  it("should build DM session key", () => {
    const gramjsMessage = createMockMessage({
      chatId: 11111,
      senderId: 11111,
      isGroup: false,
    });

    const result = buildSessionKey(gramjsMessage, "test-account");

    expect(result).toBe("telegram-gramjs:test-account:11111");
  });

  it("should build group session key", () => {
    const gramjsMessage = createMockMessage({
      chatId: 99999,
      senderId: 11111,
      isGroup: true,
    });

    const result = buildSessionKey(gramjsMessage, "test-account");

    expect(result).toBe("telegram-gramjs:test-account:group:99999");
  });

  it("should use chatId for groups, not senderId", () => {
    const gramjsMessage = createMockMessage({
      chatId: 99999,
      senderId: 11111,
      isGroup: true,
    });

    const result = buildSessionKey(gramjsMessage, "test-account");

    expect(result).toContain("99999");
    expect(result).not.toContain("11111");
  });
});

describe("extractCommand", () => {
  it("should detect Telegram commands", () => {
    const result = extractCommand("/start");

    expect(result.isCommand).toBe(true);
    expect(result.command).toBe("start");
    expect(result.args).toBeUndefined();
  });

  it("should extract command with arguments", () => {
    const result = extractCommand("/help search filters");

    expect(result.isCommand).toBe(true);
    expect(result.command).toBe("help");
    expect(result.args).toBe("search filters");
  });

  it("should handle commands with multiple spaces", () => {
    const result = extractCommand("/search   term1   term2");

    expect(result.isCommand).toBe(true);
    expect(result.command).toBe("search");
    expect(result.args).toBe("term1   term2");
  });

  it("should not detect non-commands", () => {
    const result = extractCommand("Hello, how are you?");

    expect(result.isCommand).toBe(false);
    expect(result.command).toBeUndefined();
  });

  it("should handle slash in middle of text", () => {
    const result = extractCommand("Check out http://example.com/page");

    expect(result.isCommand).toBe(false);
  });

  it("should trim whitespace", () => {
    const result = extractCommand("  /start  ");

    expect(result.isCommand).toBe(true);
    expect(result.command).toBe("start");
  });

  it("should handle command at mention", () => {
    // Telegram commands can be like /start@botname
    const result = extractCommand("/start@mybot");

    expect(result.isCommand).toBe(true);
    expect(result.command).toBe("start@mybot");
  });
});

describe("message context edge cases", () => {
  it("should handle missing optional fields", async () => {
    const gramjsMessage: GramJSMessageContext = {
      messageId: 12345,
      chatId: 67890,
      senderId: 11111,
      text: "Minimal message",
      isGroup: false,
      isChannel: false,
      // Optional fields omitted
    };

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeDefined();
    expect(result!.Body).toBe("Minimal message");
    expect(result!.ReplyToId).toBeUndefined();
    expect(result!.SenderUsername).toBeUndefined();
  });

  it("should handle very long messages", async () => {
    const longText = "A".repeat(10000);
    const gramjsMessage = createMockMessage({
      text: longText,
    });

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeDefined();
    expect(result!.Body).toBe(longText);
    expect(result!.Body.length).toBe(10000);
  });

  it("should handle special characters in text", async () => {
    const specialText = "Hello 👋 <world> & \"quotes\" 'single' \\backslash";
    const gramjsMessage = createMockMessage({
      text: specialText,
    });

    const account = createMockAccount();
    const result = await convertToMsgContext(gramjsMessage, account, "test-account");

    expect(result).toBeDefined();
    expect(result!.Body).toBe(specialText);
  });
});
