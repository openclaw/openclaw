import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
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
function skill(displayName: string, ownerHandle: string, official = false) {
  const slug = displayName.toLowerCase();
  return { slug, installRef: `@${ownerHandle}/${slug}`, ownerHandle, displayName, official };
}

async function search(clawhub: Record<string, unknown>, message?: string, workspaceDir?: string) {
  setRuntimeConfigSnapshot({});
  const result = await createMessageTool({
    config: {},
    workspaceDir,
    preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
    currentChannelProvider: "webchat",
    agentSessionKey: "agent:main:webchat:dm:clawhub-proof",
    runId: "clawhub-proof-run",
  }).execute("clawhub-search", { action: "send", message, clawhub });
  const reply = extractMessagingToolSourceReplyPayload(result);
  return { result, reply, recommendations: readClawHubRecommendations(reply?.channelData) };
}
function expectNotice(result: Awaited<ReturnType<typeof search>>["result"], text: string) {
  expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(text) }]);
}
beforeEach(() => {
  registry.plugins.mockReset().mockResolvedValue({ items: [remotePlugin] });
  registry.local
    .mockReset()
    .mockResolvedValue({ plugins: [], diagnostics: [], mutationAllowed: true });
  registry.skills.mockReset().mockResolvedValue([]);
  registry.skillStatus.mockReset().mockReturnValue({ skills: [] });
});
afterEach(clearRuntimeConfigSnapshot);

it.each([undefined, "", " \t\n"])(
  "excludes unverified publishers and gives a visible no-match outcome for message=%j",
  async (message) => {
    registry.plugins.mockResolvedValue({ items: [{ ...remotePlugin, isOfficial: false }] });
    registry.skills.mockResolvedValue([skill("WhatsApp", "openclaw")]);
    const { result, reply, recommendations } = await search({ query: "whatsapp" }, message);
    expect(recommendations).toEqual([]);
    expect(reply?.text).toContain("No official ClawHub plugin or skill match");
    expectNotice(result, "No official ClawHub plugin or skill match");
  },
);
it("preserves an explicit reply when a ClawHub search has no matches", async () => {
  const message = "Deployment complete.\nAll requested checks passed.";
  const { result, reply, recommendations } = await search(
    { query: "unmatched-capability", kind: "skill" },
    message,
  );
  expect(registry.skills).toHaveBeenCalled();
  expect(recommendations).toEqual([]);
  expect(reply?.text).toBe(message);
  expectNotice(result, "No official ClawHub skill match");
});
it("matches an official skill to its exact linked publisher instead of its display name", async () => {
  registry.skills.mockResolvedValue([{ ...skill("Calendar", "verified", true), icon: "📆" }]);
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
  const message = "Here is your calendar capability.";
  const { result, reply, recommendations } = await search(
    { query: "calendar", kind: "skill" },
    message,
    "/workspace",
  );
  expect(reply?.text).toBe(message);
  expect(recommendations).toMatchObject([
    {
      kind: "skill",
      id: "@verified/calendar",
      skillRef: "@verified/calendar",
      installed: false,
      official: true,
    },
  ]);
  expectNotice(result, "Calendar: Available to install.");
});
it("rejects model-supplied installation and official claims", async () => {
  await expect(search({ query: "whatsapp", installed: true, official: true })).rejects.toThrow();
  expect(registry.plugins).not.toHaveBeenCalled();
});
