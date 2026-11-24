import { beforeEach, describe, expect, it, vi } from "vitest";
import { listChatChannels } from "../channels/chat-meta.js";
import { listTrustedChannelPluginCatalogEntries } from "../commands/channel-setup/trusted-catalog.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { executeSystemAgentOperation } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

// mock-isolation: A fixture config keeps the real owner and workspace resolution in the path.
vi.mock("../config/config.js", () => ({ readConfigFileSnapshot: vi.fn() }));
// mock-isolation: No installed channel runtimes are loaded.
vi.mock("../channels/plugins/setup-registry.js", () => ({ listChannelSetupPlugins: () => [] }));
// mock-isolation: One synthetic built-in channel keeps the output deterministic.
vi.mock("../channels/chat-meta.js", () => ({ listChatChannels: vi.fn() }));
// mock-isolation: An empty plugin catalog records the workspace each read selects.
vi.mock("../commands/channel-setup/trusted-catalog.js", () => ({
  listManifestInstalledChannelIds: vi.fn(() => new Set()),
  listTrustedChannelPluginCatalogEntries: vi.fn(() => []),
  listSetupDiscoveryChannelPluginCatalogEntries: vi.fn(() => []),
}));

function useConfig(config: OpenClawConfig) {
  vi.mocked(readConfigFileSnapshot).mockResolvedValue({
    valid: true,
    config,
    runtimeConfig: config,
  } as ConfigFileSnapshot);
}

const multiAgentConfig: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: {
      main: { workspace: "/tmp/ws-main" },
      douglas: { workspace: "/tmp/ws-douglas" },
      "knowledge-eval": { workspace: "/tmp/ws-knowledge-eval" },
    },
  },
};

const soleAgentConfig: OpenClawConfig = {
  agents: { entries: { solo: { workspace: "/tmp/ws-solo" } } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listChatChannels).mockReturnValue([
    {
      id: "slack",
      label: "Slack",
      selectionLabel: "Slack",
      docsPath: "/channels/slack",
      blurb: "Slack app messaging.",
    },
  ]);
});

describe("system agent channel reads", () => {
  it.each([
    ["the configured system agent", multiAgentConfig, "/tmp/ws-main"],
    ["the sole agent", soleAgentConfig, "/tmp/ws-solo"],
  ])("reads channel info and list from %s", async (_name, config, workspaceDir) => {
    useConfig(config);
    const { runtime, lines } = createSystemAgentTestRuntime();

    await executeSystemAgentOperation({ kind: "channel-info", channel: "slack" }, runtime);
    expect(lines.join("\n")).toContain("Docs: https://docs.openclaw.ai/channels/slack");

    lines.length = 0;
    await executeSystemAgentOperation({ kind: "channel-list" }, runtime);
    expect(lines.join("\n")).toContain("  - slack (Slack)");

    const calls = vi.mocked(listTrustedChannelPluginCatalogEntries).mock.calls;
    expect(calls.map(([params]) => params.workspaceDir)).toEqual([workspaceDir, workspaceDir]);
  });

  it("reads channel info when the config snapshot is invalid", async () => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({ valid: false } as ConfigFileSnapshot);
    const { runtime, lines } = createSystemAgentTestRuntime();

    await executeSystemAgentOperation({ kind: "channel-info", channel: "slack" }, runtime);
    expect(lines.join("\n")).toContain("Docs: https://docs.openclaw.ai/channels/slack");
  });
});
