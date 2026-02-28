import { describe, expect, it, vi } from "vitest";
import { normalizeNonTelegramGroupPolicy } from "../../config/runtime-group-policy.js";

// @mariozechner/pi-coding-agent uses 'strip-ansi' which is a missing transitive
// dep in the published package. Mock to prevent load-time failure via:
// provider.ts → skill-commands → agents/skills/workspace → @mariozechner/pi-coding-agent
vi.mock("@mariozechner/pi-coding-agent", () => ({
  CURRENT_SESSION_VERSION: 1,
  SessionManager: vi.fn(),
  AuthStorage: vi.fn(),
  ModelRegistry: vi.fn(),
  codingTools: [],
  createReadTool: vi.fn(),
  createEditTool: vi.fn(),
  createWriteTool: vi.fn(),
  readTool: {},
  formatSkillsForPrompt: vi.fn(() => ""),
  loadSkillsFromDir: vi.fn(async () => []),
  estimateTokens: vi.fn(() => 0),
  generateSummary: vi.fn(async () => ""),
}));
import { isDiscordGroupAllowedByPolicy } from "./allow-list.js";
import { __testing } from "./provider.js";

describe("resolveDiscordRuntimeGroupPolicy", () => {
  it("fails closed when channels.discord is missing and no defaults are set", () => {
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it("keeps open default when channels.discord is configured", () => {
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it("respects explicit provider policy", () => {
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: false,
      groupPolicy: "disabled",
    });
    expect(resolved.groupPolicy).toBe("disabled");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it("ignores explicit global defaults when provider config is missing", () => {
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: false,
      defaultGroupPolicy: "open",
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
});

describe("groupPolicy 'members' normalization for Discord preflight", () => {
  it("normalizes 'members' to 'open' so guild messages are allowed", () => {
    // "members" is Telegram-only; for Discord it must normalize to "open" so
    // that guild messages pass the policy gate rather than being blocked.
    const normalized = normalizeNonTelegramGroupPolicy("members");
    expect(normalized).toBe("open");

    const allowed = isDiscordGroupAllowedByPolicy({
      groupPolicy: normalized,
      guildAllowlisted: false,
      channelAllowlistConfigured: false,
      channelAllowed: false,
    });
    expect(allowed).toBe(true);
  });

  it("normalized 'members' through full policy resolution allows guild messages", () => {
    // Simulate: provider configured, groupPolicy="members" explicitly set.
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: true,
      groupPolicy: "members",
    });
    // resolveDiscordRuntimeGroupPolicy returns the raw policy; normalization happens next.
    const normalized = normalizeNonTelegramGroupPolicy(resolved.groupPolicy);
    expect(normalized).toBe("open");

    const allowed = isDiscordGroupAllowedByPolicy({
      groupPolicy: normalized,
      guildAllowlisted: false,
      channelAllowlistConfigured: false,
      channelAllowed: false,
    });
    expect(allowed).toBe(true);
  });
});
