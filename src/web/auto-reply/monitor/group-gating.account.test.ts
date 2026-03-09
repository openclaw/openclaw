import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before imports.
vi.mock("../../accounts.js", () => ({
  resolveWhatsAppAccount: vi.fn(),
}));
vi.mock("../../../globals.js", () => ({
  logVerbose: vi.fn(),
}));
vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(() => "requireMention"),
  resolveGroupPolicyFor: vi.fn(() => ({ allowlistEnabled: false, allowed: true })),
}));
vi.mock("./group-members.js", () => ({
  noteGroupMember: vi.fn(),
}));
vi.mock("../../../auto-reply/command-detection.js", () => ({
  hasControlCommand: vi.fn(() => false),
}));
vi.mock("../../../auto-reply/group-activation.js", () => ({
  parseActivationCommand: vi.fn(() => ({ hasCommand: false })),
}));
vi.mock("../../../auto-reply/reply/history.js", () => ({
  recordPendingHistoryEntryIfEnabled: vi.fn(),
}));
vi.mock("../../../channels/mention-gating.js", () => ({
  resolveMentionGating: vi.fn(() => ({
    shouldSkip: false,
    effectiveWasMentioned: false,
  })),
}));
vi.mock("../mentions.js", () => ({
  buildMentionConfig: vi.fn(() => ({
    mentionRegexes: [],
    allowFrom: ["*"],
  })),
  debugMention: vi.fn(() => ({
    wasMentioned: false,
    details: {},
  })),
  resolveOwnerList: vi.fn(() => []),
}));
vi.mock("./commands.js", () => ({
  stripMentionsForCommand: vi.fn((body: string) => body),
}));

import { resolveWhatsAppAccount } from "../../accounts.js";
import { buildMentionConfig } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { applyGroupGating } from "./group-gating.js";

const mockedResolveAccount = vi.mocked(resolveWhatsAppAccount);
const mockedBuildMentionConfig = vi.mocked(buildMentionConfig);

function makeGroupMsg(overrides: Partial<WebInboundMsg> = {}): WebInboundMsg {
  return {
    id: "msg-1",
    from: "+15551234567",
    to: "+15559876543",
    body: "hello group",
    chatId: "group-chat-1",
    chatType: "group",
    conversationId: "testgroup@g.us",
    senderE164: "+15551234567",
    senderName: "Alice",
    ...overrides,
  } as WebInboundMsg;
}

function baseCfg() {
  return {
    channels: {
      whatsapp: {
        allowFrom: ["*"],
      },
    },
  } as ReturnType<typeof import("../../../config/config.js").loadConfig>;
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    cfg: baseCfg(),
    msg: makeGroupMsg(),
    conversationId: "testgroup@g.us",
    groupHistoryKey: "whatsapp:default:group:testgroup@g.us",
    agentId: "main",
    sessionKey: "agent:main:whatsapp:group:testgroup@g.us",
    baseMentionConfig: { mentionRegexes: [], allowFrom: ["*"] },
    authDir: "/tmp/auth",
    groupHistories: new Map(),
    groupHistoryLimit: 50,
    groupMemberNames: new Map(),
    logVerbose: vi.fn(),
    replyLogger: { debug: vi.fn() },
    ...overrides,
  };
}

describe("applyGroupGating account-level allowFrom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes accountId to resolveWhatsAppAccount and overrides allowFrom", () => {
    const accountAllowFrom = ["+15559999999"];
    const mentionConfig = { mentionRegexes: [], allowFrom: ["*"] };
    mockedBuildMentionConfig.mockReturnValue(mentionConfig);
    mockedResolveAccount.mockReturnValue({
      accountId: "acct-2",
      enabled: true,
      sendReadReceipts: true,
      authDir: "/tmp/auth",
      isLegacyAuthDir: false,
      allowFrom: accountAllowFrom,
    });

    const result = applyGroupGating(baseParams({ accountId: "acct-2" }));

    expect(mockedResolveAccount).toHaveBeenCalledWith({
      cfg: expect.anything(),
      accountId: "acct-2",
    });
    // mentionConfig.allowFrom should have been overridden with account-level value.
    expect(mentionConfig.allowFrom).toEqual(accountAllowFrom);
    expect(result.shouldProcess).toBe(true);
  });

  it("passes undefined accountId when not provided (falls back to default)", () => {
    const rootAllowFrom = ["*"];
    const mentionConfig = { mentionRegexes: [], allowFrom: ["*"] };
    mockedBuildMentionConfig.mockReturnValue(mentionConfig);
    mockedResolveAccount.mockReturnValue({
      accountId: "default",
      enabled: true,
      sendReadReceipts: true,
      authDir: "/tmp/auth",
      isLegacyAuthDir: false,
      allowFrom: rootAllowFrom,
    });

    const result = applyGroupGating(baseParams());

    expect(mockedResolveAccount).toHaveBeenCalledWith({
      cfg: expect.anything(),
      accountId: undefined,
    });
    expect(mentionConfig.allowFrom).toEqual(rootAllowFrom);
    expect(result.shouldProcess).toBe(true);
  });

  it("account-level allowFrom overrides root-level for self-chat detection", () => {
    // Root config has allowFrom: ["*"], but account restricts to specific number.
    const accountAllowFrom = ["+15551111111"];
    const mentionConfig = { mentionRegexes: [], allowFrom: ["*"] };
    mockedBuildMentionConfig.mockReturnValue(mentionConfig);
    mockedResolveAccount.mockReturnValue({
      accountId: "restricted-acct",
      enabled: true,
      sendReadReceipts: true,
      authDir: "/tmp/auth",
      isLegacyAuthDir: false,
      allowFrom: accountAllowFrom,
    });

    applyGroupGating(baseParams({ accountId: "restricted-acct" }));

    // The mentionConfig was mutated: root "*" replaced with account-specific value.
    expect(mentionConfig.allowFrom).toEqual(["+15551111111"]);
    expect(mentionConfig.allowFrom).not.toEqual(["*"]);
  });

  it("does not clobber root allowFrom when account returns undefined", () => {
    const rootAllowFrom = ["+15550000000"];
    const mentionConfig = { mentionRegexes: [], allowFrom: rootAllowFrom };
    mockedBuildMentionConfig.mockReturnValue(mentionConfig);
    mockedResolveAccount.mockReturnValue({
      accountId: "no-override-acct",
      enabled: true,
      sendReadReceipts: true,
      authDir: "/tmp/auth",
      isLegacyAuthDir: false,
      // allowFrom is undefined — should NOT overwrite the root value.
      allowFrom: undefined,
    });

    applyGroupGating(baseParams({ accountId: "no-override-acct" }));

    // Root value should be preserved, not replaced with undefined.
    expect(mentionConfig.allowFrom).toEqual(["+15550000000"]);
  });
});
