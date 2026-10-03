import { beforeEach, describe, expect, it, vi } from "vitest";
import { readClawHubRecommendations } from "../../shared/clawhub-recommendations.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-messaging-extraction.js";
import { createMessageTool } from "./message-tool-execution.js";

const registry = vi.hoisted(() => ({
  plugins: vi.fn(),
  local: vi.fn(),
  skills: vi.fn(),
  skillStatus: vi.fn(),
}));
vi.mock("../../infra/clawhub-plugin-catalog.js", () => ({
  fetchClawHubPluginCatalog: registry.plugins,
}));
vi.mock("../../plugins/management-service.js", () => ({ listManagedPlugins: registry.local }));
vi.mock("../../infra/clawhub-skills.js", () => ({ searchClawHubSkills: registry.skills }));
vi.mock("../../skills/discovery/status.js", () => ({
  prepareWorkspaceSkillStatus: async (...args: unknown[]) => ({
    report: registry.skillStatus(...args),
    files: [],
  }),
}));

const remotePlugin = {
  packageName: "@openclaw/whatsapp",
  displayName: "WhatsApp",
  family: "code-plugin",
  isOfficial: true,
  categories: ["channels"],
  runtimeId: "whatsapp",
};
const catalog = { version: 0, channels: [], getChannel: () => undefined } as const;

function messageTool(config = {}, options: Partial<Parameters<typeof createMessageTool>[0]> = {}) {
  return createMessageTool({
    config,
    preparedMessageToolCatalog: catalog,
    currentChannelProvider: "webchat",
    agentSessionKey: "agent:main:webchat:dm:clawhub-proof",
    runId: "clawhub-proof-run",
    getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
    resolveCommandSecretRefsViaGateway: async () => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }),
    ...options,
  });
}

beforeEach(() => {
  registry.plugins.mockReset().mockResolvedValue({ items: [remotePlugin] });
  registry.local
    .mockReset()
    .mockResolvedValue({ plugins: [], diagnostics: [], mutationAllowed: true });
  registry.skills.mockReset().mockResolvedValue([]);
  registry.skillStatus.mockReset().mockReturnValue({ skills: [] });
});

describe("ClawHub message recommendations", () => {
  it("excludes unverified publisher claims and gives a visible no-match outcome", async () => {
    registry.plugins.mockResolvedValue({ items: [{ ...remotePlugin, isOfficial: false }] });
    registry.skills.mockResolvedValue([
      {
        slug: "whatsapp",
        installRef: "@openclaw/whatsapp",
        ownerHandle: "openclaw",
        displayName: "WhatsApp",
        official: false,
      },
    ]);
    const result = await messageTool().execute("no-match", {
      action: "send",
      clawhub: { query: "whatsapp" },
    });
    const reply = extractMessagingToolSourceReplyPayload(result);
    expect(readClawHubRecommendations(reply?.channelData)).toEqual([]);
    expect(reply?.text).toContain("No official ClawHub plugin or skill match");
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("No official ClawHub plugin or skill match") },
    ]);
  });

  it("matches an official skill to its exact linked publisher instead of its display name", async () => {
    registry.skills.mockResolvedValue([
      {
        slug: "calendar",
        installRef: "@verified/calendar",
        ownerHandle: "verified",
        displayName: "Calendar",
        official: true,
        icon: "📆",
      },
    ]);
    registry.skillStatus.mockReturnValue({
      skills: [
        {
          clawhub: {
            valid: true,
            registry: "https://clawhub.ai",
            slug: "calendar",
            ownerHandle: "another",
          },
        },
      ],
    });
    const tool = messageTool({}, { workspaceDir: "/workspace" });
    const result = await tool.execute("skill-card", {
      action: "send",
      message: "Here is your calendar capability.",
      clawhub: { query: "calendar", kind: "skill" },
    });
    expect(
      readClawHubRecommendations(extractMessagingToolSourceReplyPayload(result)?.channelData),
    ).toEqual([
      expect.objectContaining({
        kind: "skill",
        id: "@verified/calendar",
        skillRef: "@verified/calendar",
        installed: false,
        official: true,
      }),
    ]);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("Calendar: Available to install.") },
    ]);
  });

  it("rejects model-supplied installation and official claims", async () => {
    await expect(
      messageTool().execute("forged-status", {
        action: "send",
        clawhub: { query: "whatsapp", installed: true, official: true },
      }),
    ).rejects.toThrow();
    expect(registry.plugins).not.toHaveBeenCalled();
  });
});
