import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
  resolveGatewayPort: () => 18789,
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "my-agent",
}));

import { createSelfInfoTool } from "./self-info-tool.js";

describe("self_info tool", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("is NOT ownerOnly", () => {
    const tool = createSelfInfoTool();
    expect(tool.ownerOnly).toBeUndefined();
    expect(tool.name).toBe("self_info");
  });

  it("identity action calls agent.identity.get", async () => {
    const identityResult = { name: "TestBot", avatar: "🤖", description: "A test bot" };
    callGatewayMock.mockResolvedValue(identityResult);

    const tool = createSelfInfoTool();
    const result = await tool.execute("call-1", { action: "identity" });

    expect(callGatewayMock).toHaveBeenCalledOnce();
    const call = callGatewayMock.mock.calls[0]?.[0] as { method?: string };
    expect(call?.method).toBe("agent.identity.get");
  });

  it("widget_link action returns constructed URL", async () => {
    callGatewayMock.mockResolvedValue({
      meta: { widgetBaseUrl: "https://app.example.com" },
    });

    const tool = createSelfInfoTool({ agentSessionKey: "agent:my-agent:main" });
    const result = await tool.execute("call-2", { action: "widget_link" });

    const content = result?.content;
    expect(content).toBeDefined();
    const text = Array.isArray(content) ? content[0]?.text : undefined;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.widgetLink).toBe("https://app.example.com/chat/my-agent");
    expect(parsed.agentName).toBe("my-agent");
  });

  it("widget_link action returns error when not configured", async () => {
    callGatewayMock.mockResolvedValue({ meta: {} });

    const tool = createSelfInfoTool();
    const result = await tool.execute("call-3", { action: "widget_link" });

    const content = result?.content;
    const text = Array.isArray(content) ? content[0]?.text : undefined;
    const parsed = JSON.parse(text as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("not configured");
  });

  it("channels action calls channels.status", async () => {
    const channelsResult = { telegram: { enabled: true }, discord: { enabled: false } };
    callGatewayMock.mockResolvedValue(channelsResult);

    const tool = createSelfInfoTool();
    await tool.execute("call-4", { action: "channels" });

    const call = callGatewayMock.mock.calls[0]?.[0] as { method?: string };
    expect(call?.method).toBe("channels.status");
  });

  it("model action extracts default model", async () => {
    callGatewayMock.mockResolvedValue({
      agents: { defaults: { model: "claude-sonnet-4-20250514" }, list: [] },
    });

    const tool = createSelfInfoTool({ agentSessionKey: "agent:my-agent:main" });
    const result = await tool.execute("call-5", { action: "model" });

    const content = result?.content;
    const text = Array.isArray(content) ? content[0]?.text : undefined;
    const parsed = JSON.parse(text as string);
    expect(parsed.defaultModel).toBe("claude-sonnet-4-20250514");
  });

  it("config_summary strips sensitive fields", async () => {
    callGatewayMock.mockResolvedValue({
      meta: { widgetBaseUrl: "https://app.example.com" },
      agents: { defaults: { model: "gpt-4" } },
      channels: {
        telegram: { enabled: true, botToken: "SECRET_TOKEN" },
        discord: { enabled: false, token: "DISCORD_SECRET" },
      },
      browser: { enabled: true },
      // Sensitive fields that should NOT appear
      auth: { secret: "supersecret" },
      gateway: { token: "gatewaytoken" },
    });

    const tool = createSelfInfoTool();
    const result = await tool.execute("call-6", { action: "config_summary" });

    const content = result?.content;
    const text = Array.isArray(content) ? content[0]?.text : undefined;
    const parsed = JSON.parse(text as string);

    // Safe fields should be present
    expect(parsed["meta.widgetBaseUrl"]).toBe("https://app.example.com");
    expect(parsed["agents.defaults.model"]).toBe("gpt-4");
    expect(parsed["browser.enabled"]).toBe(true);

    // Channel enabled status should be extracted
    expect(parsed.channels).toEqual({ telegram: true, discord: false });

    // Sensitive fields must NOT be present
    expect(text).not.toContain("SECRET_TOKEN");
    expect(text).not.toContain("DISCORD_SECRET");
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain("gatewaytoken");
  });

  it("throws on unknown action", async () => {
    const tool = createSelfInfoTool();
    await expect(tool.execute("call-7", { action: "unknown" })).rejects.toThrow("Unknown action");
  });
});
