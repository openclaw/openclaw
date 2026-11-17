import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { ClawHubRequestError } from "../../infra/clawhub-client.js";
import { resolvePluginDiscoveryIdentity } from "../../plugins/catalog-discovery.js";
import { readClawHubRecommendations } from "../../shared/clawhub-recommendations.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-messaging-extraction.js";
import { createMessageTool } from "./message-tool-execution.js";

const registry = vi.hoisted(() => ({
  plugins: vi.fn(),
  detail: vi.fn(),
  local: vi.fn(),
  skills: vi.fn(),
  skillStatus: vi.fn(),
}));
vi.mock("../../infra/clawhub-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/clawhub-plugin-catalog.js")>()),
  fetchClawHubPluginCatalog: registry.plugins,
  fetchClawHubPluginDetail: registry.detail,
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

async function search(
  clawhub: Record<string, unknown>,
  message?: string,
  workspaceDir?: string,
  sendParams: Record<string, unknown> = {},
) {
  setRuntimeConfigSnapshot({});
  const result = await createMessageTool({
    config: {},
    workspaceDir,
    preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
    currentChannelProvider: "webchat",
    agentSessionKey: "agent:main:webchat:dm:clawhub-proof",
    runId: "clawhub-proof-run",
  }).execute("clawhub-search", { action: "send", ...sendParams, message, clawhub });
  const reply = extractMessagingToolSourceReplyPayload(result);
  return { result, reply, recommendations: readClawHubRecommendations(reply?.channelData) };
}
function expectNotice(result: Awaited<ReturnType<typeof search>>["result"], text: string) {
  expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(text) }]);
}
beforeEach(() => {
  registry.plugins.mockReset().mockResolvedValue({ items: [remotePlugin] });
  registry.detail.mockReset();
  registry.local
    .mockReset()
    .mockResolvedValue({ plugins: [], diagnostics: [], mutationAllowed: true });
  registry.skills.mockReset().mockResolvedValue([]);
  registry.skillStatus.mockReset().mockReturnValue({ skills: [] });
});
afterEach(clearRuntimeConfigSnapshot);

it("excludes unverified publishers and replaces a blank reply with the no-match outcome", async () => {
  registry.plugins.mockResolvedValue({ items: [{ ...remotePlugin, isOfficial: false }] });
  registry.skills.mockResolvedValue([skill("WhatsApp", "openclaw")]);
  const { result, reply, recommendations } = await search({ query: "whatsapp" }, " \t\n");
  expect(recommendations).toEqual([]);
  expect(reply?.text).toContain("No official ClawHub plugin or skill match");
  expectNotice(result, "No official ClawHub plugin or skill match");
});
it("matches an official skill to its exact linked publisher instead of its display name", async () => {
  registry.skills.mockResolvedValue([{ ...skill("Calendar", "verified", true), icon: "📆" }]);
  const link = {
    valid: true,
    registry: "https://clawhub.ai",
    slug: "calendar",
    ownerHandle: "another",
  };
  registry.skillStatus.mockReturnValue({
    skills: [{ clawhub: link }],
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
it("preserves a media caption alongside intentional recommendation cards", async () => {
  const caption = "Screenshot evidence for the recommended capability.";
  const media = "https://example.com/evidence.png";
  const { result, reply, recommendations } = await search(
    { query: "whatsapp", kind: "plugin" },
    " \t\n",
    "/workspace",
    { caption, media },
  );
  expect(reply?.text).toBe(caption);
  expect(reply?.mediaUrls).toEqual([media]);
  expect(recommendations).toMatchObject([{ name: "WhatsApp", installed: false }]);
  expectNotice(result, "WhatsApp: Available to install.");
});
it("rejects model-supplied installation and official claims", async () => {
  await expect(search({ query: "whatsapp", installed: true, official: true })).rejects.toThrow();
  expect(registry.plugins).not.toHaveBeenCalled();
});
it.each([
  {
    packageName: "@expediagroup/expedia-openclaw",
    displayName: "Expedia Travel",
    isOfficial: true,
  },
  { packageName: "openclaw-travel-themes", displayName: "Travel Themes", isOfficial: false },
])(
  "shows only the exactly named plugin $packageName without searching",
  async ({ packageName, displayName, isOfficial }) => {
    registry.detail.mockResolvedValue({ ...remotePlugin, packageName, displayName, isOfficial });
    registry.local.mockResolvedValue({
      plugins: [{ id: "installed", installed: true, clawhubPackage: packageName }],
      diagnostics: [],
      mutationAllowed: true,
    });
    const { result, reply, recommendations } = await search({ plugin: ` ${packageName} ` });
    expect(reply?.text).toBeUndefined();
    expect(registry.detail).toHaveBeenCalledWith({ packageName });
    expect(registry.plugins).not.toHaveBeenCalled();
    expect(registry.skills).not.toHaveBeenCalled();
    expect(recommendations).toMatchObject([
      { kind: "plugin", name: displayName, official: isOfficial, installed: true },
    ]);
    expect(resolvePluginDiscoveryIdentity(recommendations[0]!.id)).toEqual({
      origin: "clawhub",
      identity: packageName,
    });
    expectNotice(result, `${displayName}: Installed.`);
  },
);
it("shows an uninstalled community card without redundant status text", async () => {
  registry.detail.mockResolvedValue({
    ...remotePlugin,
    packageName: "openclaw-travel-themes",
    displayName: "Travel Themes",
    isOfficial: false,
  });
  const { result, reply, recommendations } = await search({ plugin: "openclaw-travel-themes" });
  expect(reply?.text).toBeUndefined();
  expect(recommendations).toMatchObject([
    { name: "Travel Themes", installed: false, official: false },
  ]);
  // Status remains in the private tool receipt so the agent knows what was sent.
  expectNotice(result, "Travel Themes: Available to install.");
});
it.each([
  [
    "a package that is missing or not a plugin",
    new ClawHubRequestError({ path: "/detail", status: 404, body: "Package not found" }),
    "No ClawHub plugin named “openclaw-music-manager” was found",
  ],
  ["a registry failure", new Error("fetch failed"), "ClawHub recommendations are unavailable"],
])("shows no card for %s in an exact plugin request", async (_case, error, text) => {
  registry.detail.mockRejectedValue(error);
  const { result, reply, recommendations } = await search({ plugin: "openclaw-music-manager" });
  expect(recommendations).toEqual([]);
  expect(reply?.text).toContain(text);
  expectNotice(result, text);
  expect(registry.plugins).not.toHaveBeenCalled();
  expect(registry.skills).not.toHaveBeenCalled();
});
it("rejects an exact plugin name combined with search fields", async () => {
  await expect(search({ plugin: "@openclaw/whatsapp", query: "whatsapp" })).rejects.toThrow(
    "either query",
  );
  await expect(search({ plugin: "@openclaw/whatsapp", kind: "plugin" })).rejects.toThrow();
  expect(registry.detail).not.toHaveBeenCalled();
  expect(registry.plugins).not.toHaveBeenCalled();
});
