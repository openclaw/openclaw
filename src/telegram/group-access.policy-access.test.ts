import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import { evaluateTelegramGroupPolicyAccess } from "./group-access.js";

/**
 * Minimal stubs shared across tests.
 */
const baseCfg = {
  channels: { telegram: {} },
} as unknown as OpenClawConfig;

const baseTelegramCfg: TelegramAccountConfig = {
  groupPolicy: "allowlist",
} as unknown as TelegramAccountConfig;

const emptyAllow = { entries: [], hasWildcard: false, hasEntries: false, invalidEntries: [] };
const senderAllow = {
  entries: ["111"],
  hasWildcard: false,
  hasEntries: true,
  invalidEntries: [],
};

describe("evaluateTelegramGroupPolicyAccess – chat allowlist vs sender allowlist ordering", () => {
  it("allows a group explicitly listed in groups config even when no allowFrom entries exist", () => {
    // Issue #30613: a group configured with a dedicated entry (groupConfig set)
    // should be allowed even without any allowFrom / groupAllowFrom entries.
    const result = evaluateTelegramGroupPolicyAccess({
      isGroup: true,
      chatId: "-100123456",
      cfg: baseCfg,
      telegramCfg: baseTelegramCfg,
      effectiveGroupAllow: emptyAllow,
      senderId: "999",
      senderUsername: "user",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false }, // dedicated entry — not just wildcard
      }),
      enforcePolicy: true,
      useTopicAndGroupOverrides: false,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("still blocks when only wildcard match and no allowFrom entries", () => {
    // groups: { "*": ... } with no allowFrom → wildcard does NOT bypass sender checks.
    const result = evaluateTelegramGroupPolicyAccess({
      isGroup: true,
      chatId: "-100123456",
      cfg: baseCfg,
      telegramCfg: baseTelegramCfg,
      effectiveGroupAllow: emptyAllow,
      senderId: "999",
      senderUsername: "user",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: undefined, // wildcard match only — no dedicated entry
      }),
      enforcePolicy: true,
      useTopicAndGroupOverrides: false,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-empty",
      groupPolicy: "allowlist",
    });
  });

  it("rejects a group NOT in groups config", () => {
    const result = evaluateTelegramGroupPolicyAccess({
      isGroup: true,
      chatId: "-100999999",
      cfg: baseCfg,
      telegramCfg: baseTelegramCfg,
      effectiveGroupAllow: emptyAllow,
      senderId: "999",
      senderUsername: "user",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: false,
      }),
      enforcePolicy: true,
      useTopicAndGroupOverrides: false,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-chat-not-allowed",
      groupPolicy: "allowlist",
    });
  });

  it("still enforces sender allowlist when checkChatAllowlist is disabled", () => {
    const result = evaluateTelegramGroupPolicyAccess({
      isGroup: true,
      chatId: "-100123456",
      cfg: baseCfg,
      telegramCfg: baseTelegramCfg,
      effectiveGroupAllow: emptyAllow,
      senderId: "999",
      senderUsername: "user",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false },
      }),
      enforcePolicy: true,
      useTopicAndGroupOverrides: false,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: false,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-empty",
      groupPolicy: "allowlist",
    });
  });

  it("blocks unauthorized sender even when chat is explicitly allowed and sender entries exist", () => {
    const result = evaluateTelegramGroupPolicyAccess({
      isGroup: true,
      chatId: "-100123456",
      cfg: baseCfg,
      telegramCfg: baseTelegramCfg,
      effectiveGroupAllow: senderAllow, // entries: ["111"]
      senderId: "222", // not in senderAllow.entries
      senderUsername: "other",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false },
      }),
      enforcePolicy: true,
      useTopicAndGroupOverrides: false,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });

    // Chat is explicitly allowed, but sender entries exist and sender is not in them.
    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-unauthorized",
      groupPolicy: "allowlist",
    });
  });

  it("allows when groupPolicy is open regardless of allowlist state", () => {
    const result = evaluateTelegramGroupPolicyAccess({
      isGroup: true,
      chatId: "-100123456",
      cfg: baseCfg,
      telegramCfg: { groupPolicy: "open" } as unknown as TelegramAccountConfig,
      effectiveGroupAllow: emptyAllow,
      senderId: "999",
      senderUsername: "user",
      resolveGroupPolicy: () => ({
        allowlistEnabled: false,
        allowed: false,
      }),
      enforcePolicy: true,
      useTopicAndGroupOverrides: false,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "open" });
  });

  it("rejects when groupPolicy is disabled", () => {
    const result = evaluateTelegramGroupPolicyAccess({
      isGroup: true,
      chatId: "-100123456",
      cfg: baseCfg,
      telegramCfg: { groupPolicy: "disabled" } as unknown as TelegramAccountConfig,
      effectiveGroupAllow: emptyAllow,
      senderId: "999",
      senderUsername: "user",
      resolveGroupPolicy: () => ({
        allowlistEnabled: false,
        allowed: false,
      }),
      enforcePolicy: true,
      useTopicAndGroupOverrides: false,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-disabled",
      groupPolicy: "disabled",
    });
  });

  it("allows non-group messages without any checks", () => {
    const result = evaluateTelegramGroupPolicyAccess({
      isGroup: false,
      chatId: "12345",
      cfg: baseCfg,
      telegramCfg: baseTelegramCfg,
      effectiveGroupAllow: emptyAllow,
      senderId: "999",
      senderUsername: "user",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: false,
      }),
      enforcePolicy: true,
      useTopicAndGroupOverrides: false,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("allows authorized sender in wildcard-matched group with sender entries", () => {
    const result = evaluateTelegramGroupPolicyAccess({
      isGroup: true,
      chatId: "-100123456",
      cfg: baseCfg,
      telegramCfg: baseTelegramCfg,
      effectiveGroupAllow: senderAllow, // entries: ["111"]
      senderId: "111", // IS in senderAllow.entries
      senderUsername: "user",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: undefined, // wildcard only
      }),
      enforcePolicy: true,
      useTopicAndGroupOverrides: false,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });
});
