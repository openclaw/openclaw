import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleQuotaCommand } from "./commands-quota.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

// Mock provider-usage modules
const mockLoadProviderUsageSummary = vi.hoisted(() => vi.fn());
const mockFormatUsageReportLines = vi.hoisted(() => vi.fn());

vi.mock("../../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: mockLoadProviderUsageSummary,
  formatUsageReportLines: mockFormatUsageReportLines,
}));

vi.mock("../../infra/provider-usage.shared.js", () => ({
  usageProviders: [
    "anthropic",
    "github-copilot",
    "google-antigravity",
    "google-gemini-cli",
    "minimax",
    "moonshot",
    "openai-codex",
    "xiaomi",
    "zai",
  ],
}));

vi.mock("../../config/env-vars.js", () => ({
  collectConfigEnvVars: vi.fn(() => ({ CLAUDE_AI_SESSION_KEY: undefined })),
}));

function buildQuotaParams(commandBody: string, cfg: OpenClawConfig) {
  return buildCommandTestParams(commandBody, cfg);
}

describe("handleQuotaCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when text commands are disabled", async () => {
    const cfg = { commands: { text: false } } as OpenClawConfig;
    const params = buildQuotaParams("/quota", cfg);
    const result = await handleQuotaCommand(params, false);
    expect(result).toBeNull();
  });

  it("returns null for non-quota commands", async () => {
    const cfg = { commands: { text: true } } as OpenClawConfig;
    const params = buildQuotaParams("/status", cfg);
    const result = await handleQuotaCommand(params, true);
    expect(result).toBeNull();
  });

  it("blocks unauthorized senders", async () => {
    const cfg = { commands: { text: true } } as OpenClawConfig;
    const params = buildQuotaParams("/quota", cfg);
    params.command.isAuthorizedSender = false;
    params.command.senderId = "unauthorized-user";
    const result = await handleQuotaCommand(params, true);
    expect(result).toEqual({ shouldContinue: false });
  });

  it("excludes Gemini from provider list when fetching quota", async () => {
    const cfg = { commands: { text: true } } as OpenClawConfig;
    const params = buildQuotaParams("/quota", cfg);

    mockLoadProviderUsageSummary.mockResolvedValueOnce({
      updatedAt: Date.now(),
      providers: [],
    });
    mockFormatUsageReportLines.mockReturnValueOnce(["Usage:", "  No providers"])

    await handleQuotaCommand(params, true);

    expect(mockLoadProviderUsageSummary).toHaveBeenCalledOnce();
    const callArg = mockLoadProviderUsageSummary.mock.calls[0]?.[0];
    
    // Verify providers list excludes Gemini
    expect(callArg.providers).toBeDefined();
    expect(callArg.providers).toContain("anthropic");
    expect(callArg.providers).toContain("github-copilot");
    expect(callArg.providers).toContain("google-antigravity");
    expect(callArg.providers).not.toContain("google-gemini-cli");
    expect(callArg.providers).toContain("minimax");
    expect(callArg.providers).toContain("moonshot");
    expect(callArg.providers).toContain("openai-codex");
    expect(callArg.providers).toContain("xiaomi");
    expect(callArg.providers).toContain("zai");
  });

  it("formats and returns quota data", async () => {
    const cfg = { commands: { text: true } } as OpenClawConfig;
    const params = buildQuotaParams("/quota", cfg);

    mockLoadProviderUsageSummary.mockResolvedValueOnce({
      updatedAt: Date.now(),
      providers: [
        { provider: "anthropic", displayName: "Claude", windows: [{ label: "5h", usedPercent: 20 }] },
      ],
    });
    mockFormatUsageReportLines.mockReturnValueOnce(["Usage:", "  Claude", "    5h: 80% left"]);

    const result = await handleQuotaCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("Usage:\n  Claude\n    5h: 80% left");
  });

  it("handles errors gracefully", async () => {
    const cfg = { commands: { text: true } } as OpenClawConfig;
    const params = buildQuotaParams("/quota", cfg);

    mockLoadProviderUsageSummary.mockRejectedValueOnce(new Error("Network error"));

    const result = await handleQuotaCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Usage: error fetching quota");
    expect(result?.reply?.text).toContain("Network error");
  });
});
