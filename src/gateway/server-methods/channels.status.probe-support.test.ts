import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  createChannelPlugin,
  createChannelsStatusHarness,
  firstChannelAccount,
} from "./channels.status.test-helpers.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  listChannelPlugins: vi.fn(),
  normalizeChannelId: vi.fn<(value: string) => string | null>((value) => value),
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  buildChannelUiCatalog: vi.fn(),
  buildChannelAccountSnapshotFromAccount: vi.fn(),
  getChannelActivity: vi.fn(),
  callGateway: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../call.js")>()),
  callGateway: mocks.callGateway,
}));

vi.mock("../../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: vi.fn(async () => ({
    config: {},
    path: "openclaw.config.json",
    raw: "{}",
  })),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
  getLoadedChannelPlugin: vi.fn(),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  buildChannelUiCatalog: mocks.buildChannelUiCatalog,
}));

vi.mock("../../channels/plugins/status.js", () => ({
  buildChannelAccountSnapshotFromAccount: mocks.buildChannelAccountSnapshotFromAccount,
}));

vi.mock("../../infra/channel-activity.js", () => ({
  getChannelActivity: mocks.getChannelActivity,
}));

import { channelsHandlers } from "./channels.js";

const { createOptions, runChannelsStatus } = createChannelsStatusHarness({
  handler: expectDefined(channelsHandlers["channels.status"], "channels.status handler"),
  getRuntimeConfig: mocks.getRuntimeConfig,
});

describe("channels.status probe support", () => {
  afterEach(() => {
    setActiveDegradedSecretOwners([]);
    setActivePluginRegistry(createTestRegistry([]));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeChannelId.mockImplementation((value: string) => value);
    mocks.listReadOnlyChannelPluginsForConfig.mockImplementation(() => mocks.listChannelPlugins());
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.buildChannelUiCatalog.mockReturnValue({
      order: ["whatsapp"],
      labels: { whatsapp: "WhatsApp" },
      detailLabels: { whatsapp: "WhatsApp" },
      systemImages: { whatsapp: undefined },
      entries: { whatsapp: { id: "whatsapp" } },
    });
    mocks.buildChannelAccountSnapshotFromAccount.mockResolvedValue({
      accountId: "default",
      configured: true,
    });
    mocks.getChannelActivity.mockReturnValue({
      inboundAt: null,
      outboundAt: null,
    });
    mocks.listChannelPlugins.mockReturnValue([createChannelPlugin()]);
  });

  it.each([
    { supported: false, probe: true, enabled: true, configured: true },
    { supported: true, probe: true, enabled: true, configured: true },
    { supported: true, probe: false, enabled: true, configured: true },
    { supported: true, probe: true, enabled: false, configured: true },
    { supported: true, probe: true, enabled: true, configured: false },
  ])(
    "reports probe support independently of execution ($supported/$probe/$enabled/$configured)",
    async ({ supported, probe, enabled, configured }) => {
      const probeAccount = vi.fn(async () => ({ ok: true }));
      const plugin = createChannelPlugin(supported ? { probeAccount } : {});
      plugin.config.isEnabled = () => enabled;
      plugin.config.isConfigured = () => configured;
      mocks.listChannelPlugins.mockReturnValue([plugin]);

      const payload = await runChannelsStatus({ probe });
      expect(firstChannelAccount(payload, "whatsapp").probeSupported).toBe(supported);
      expect(probeAccount).toHaveBeenCalledTimes(
        supported && probe && enabled && configured ? 1 : 0,
      );
    },
  );

  it("leaves probe support unknown for a manifest-only fallback", async () => {
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([createChannelPlugin()]);
    const payload = await runChannelsStatus({ probe: true });
    expect(firstChannelAccount(payload, "whatsapp")).not.toHaveProperty("probeSupported");
  });

  it("reports recorded account state while reload has paused plugin callbacks", async () => {
    const refuse = vi.fn(() => {
      throw new Error("plugin is quiesced");
    });
    const plugin = createChannelPlugin({
      probeAccount: refuse,
      buildChannelSummary: refuse,
      collectStatusIssues: refuse,
    });
    plugin.config.listAccountIds = refuse;
    plugin.config.resolveAccount = refuse;
    mocks.listChannelPlugins.mockReturnValue([plugin]);
    const account = { accountId: "recorded", configured: true, running: false };
    const options = createOptions({});
    options.context.getRuntimeSnapshot = () => ({
      channels: { whatsapp: account },
      channelAccounts: { whatsapp: { recorded: account } },
      reloadingChannels: new Map([["whatsapp", "recorded"]]),
    });
    const payload = await runChannelsStatus({ probe: true }, { context: options.context });
    expect(firstChannelAccount(payload, "whatsapp")).toEqual(account);
    expect(firstChannelAccount(payload, "whatsapp")).not.toHaveProperty("probeSupported");
    expect(payload.channelDefaultAccountId).toEqual({ whatsapp: "recorded" });
    expect(payload.partial).toBe(true);
    expect(payload.warnings).toEqual([
      "whatsapp: plugin runtime is paused for reload; reporting recorded account state",
    ]);
    expect(payload.statusIssues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "recorded",
        kind: "runtime",
        message: "Channel is enabled and configured, but its runtime is not running.",
      }),
    ]);
    expect(refuse).not.toHaveBeenCalled();
    expect(mocks.buildChannelAccountSnapshotFromAccount).not.toHaveBeenCalled();
  });
});
