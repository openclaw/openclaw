import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { AgentRouteBinding } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAccountListHelpers } from "../plugin-sdk/account-helpers.js";
import { createScopedChannelConfigAdapter } from "../plugin-sdk/channel-config-helpers.js";
import type { OfficialExternalPluginRepairHint } from "../plugins/official-external-plugin-repair-hints.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import {
  buildProviderStatusIndex,
  buildProviderSummaryMetadataIndex,
  listProvidersForAgent,
  summarizeBindings,
} from "./agents.providers.js";

type Plugin = ChannelPlugin<ChannelAccountSnapshot>;
const mocks = vi.hoisted(() => ({
  listReadOnlyChannelPluginsForConfig: vi.fn<() => ChannelPlugin[]>(() => []),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : null,
  ),
  resolveChannelDefaultAccountId: vi.fn(() => "default"),
  isChannelVisibleInConfiguredLists: vi.fn(() => true),
  listExplicitConfiguredChannelIdsForConfig: vi.fn<() => string[]>(() => []),
  resolveMissingOfficialExternalChannelPluginRepairHints: vi.fn<
    () => OfficialExternalPluginRepairHint[]
  >(() => []),
}));
vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: mocks.normalizeChannelId,
  getChannelPlugin: mocks.getChannelPlugin,
}));
vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));
vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: mocks.resolveChannelDefaultAccountId,
}));
vi.mock("../channels/plugins/exposure.js", () => ({
  isChannelVisibleInConfiguredLists: mocks.isChannelVisibleInConfiguredLists,
}));
vi.mock("../plugins/channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: mocks.listExplicitConfiguredChannelIdsForConfig,
}));
vi.mock("../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints:
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints,
}));

function plugin(
  id: string,
  accounts: ChannelAccountSnapshot[],
  config: Partial<Plugin["config"]> = {},
): Plugin {
  const resolveAccount = (_cfg: OpenClawConfig, accountId?: string | null) => {
    const account = accounts.find((entry) => entry.accountId === (accountId ?? "default"));
    if (!account) {
      throw new Error("Unexpected fixture account");
    }
    return account;
  };
  return {
    id,
    meta: { id, label: id, selectionLabel: id, docsPath: `/channels/${id}`, blurb: "Fixture" },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => accounts.map((account) => account.accountId),
      resolveAccount,
      describeAccount: (account) => account,
      ...config,
    },
  };
}
const repairHint = "Install the official Feishu plugin.";
const missingMetadata = {
  label: "Feishu",
  defaultAccountId: "default",
  visibleInConfiguredLists: true,
  repairHint,
};
const route = (channel: string, accountId?: string): AgentRouteBinding => ({
  agentId: "proof",
  match: { channel, accountId },
});
function displayAccount(
  provider: string,
  accountId: string,
  name: string,
  state: "configured" | "not configured" | "disabled",
) {
  return {
    provider,
    accountId,
    name,
    state,
    configured: state === "configured",
    enabled: state !== "disabled",
    visibleInConfiguredLists: true,
  };
}
const displayStatuses: Awaited<ReturnType<typeof buildProviderStatusIndex>> = new Map([
  ["telegram:default", displayAccount("telegram", "default", "Default", "not configured")],
  ["telegram:alpha", displayAccount("telegram", "alpha", "Alpha", "configured")],
  ["telegram:beta", displayAccount("telegram", "beta", "Beta", "disabled")],
  ["imessage:alpha", displayAccount("imessage", "Alpha", "Work", "configured")],
]);
type MetadataEntry = Parameters<ReturnType<typeof buildProviderSummaryMetadataIndex>["set"]>;
const displayMetadata = new Map<MetadataEntry[0], MetadataEntry[1]>([
  ["telegram", { label: "Telegram", defaultAccountId: "alpha", visibleInConfiguredLists: true }],
  ["imessage", { label: "iMessage", defaultAccountId: "default", visibleInConfiguredLists: true }],
  ["feishu", missingMetadata],
]);

describe("agent provider inventories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.listExplicitConfiguredChannelIdsForConfig.mockReturnValue([]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockReturnValue([]);
    mocks.normalizeChannelId.mockImplementation((value) =>
      typeof value === "string" && value.trim().length > 0 ? value : null,
    );
  });

  it("builds a read-only mixed account inventory without exposing unavailable credentials", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: { accounts: { Alpha: { name: "Alias" }, alpha: { name: "Exact" }, Secret: {} } },
      },
    };
    const inspectAccount = vi.fn(() => ({
      accountId: "default",
      enabled: true,
      configured: true,
      linked: true,
      name: "Work",
    }));
    const resolveAccount = vi.fn(() => {
      throw new Error("must inspect read-only accounts");
    });
    const inspected = plugin("workchat", [{ accountId: "default" }], {
      inspectAccount,
      resolveAccount,
    });
    const prepared = plugin("prepared", [{ accountId: "work" }], {
      resolveAccount,
      resolveAccountAsync: async () => ({
        accountId: "work",
        name: "Prepared",
        enabled: true,
        configured: true,
      }),
    });
    const unavailable = plugin(
      "telegram",
      [
        {
          accountId: "default",
          enabled: true,
          configured: true,
          tokenStatus: "configured_unavailable",
        },
      ],
      {
        isConfigured: () => false,
      },
    );
    const slack = plugin(
      "slack",
      [
        {
          accountId: "optional",
          enabled: true,
          configured: true,
          userTokenStatus: "configured_unavailable",
        },
        {
          accountId: "missing",
          enabled: true,
          configured: false,
          botTokenStatus: "configured_unavailable",
          appTokenStatus: "missing",
        },
        {
          accountId: "unavailable",
          enabled: true,
          configured: true,
          botTokenStatus: "configured_unavailable",
          appTokenStatus: "available",
        },
      ],
      {
        isConfigured: (account) => account.accountId === "optional",
        describeAccount: (account) => ({
          accountId: account.accountId,
          enabled: true,
          configured: account.accountId !== "unavailable",
        }),
      },
    );
    const isLinked = vi.fn(() => {
      throw new Error("linkage unavailable");
    });
    const unconfigured = plugin("quietchat", [{ accountId: "default", enabled: true }], {
      describeAccount: undefined,
      isConfigured: () => false,
      isLinked,
    });
    const custom = plugin(
      "legacychat",
      [{ accountId: "default", enabled: true, configured: true }],
      {
        describeAccount: undefined,
        isConfigured: () => true,
      },
    );
    const resolveAccountState = vi.fn(() => "enabled" as const);
    custom.status = { resolveAccountState };
    const disabled = plugin("disabledchat", [
      { accountId: "default", enabled: false, configured: false },
    ]);
    const calls: Array<string | null | undefined> = [];
    const resolveRawAccount = (config: OpenClawConfig, requestedId?: string | null) => {
      calls.push(requestedId);
      if (requestedId === "Secret") {
        throw new Error("unresolved SecretRef: PRIVATE_PROVIDER_TOKEN");
      }
      const accountId = normalizeAccountId(requestedId);
      const account = resolveAccountEntry(config.channels?.imessage?.accounts, accountId);
      return {
        accountId,
        name: account?.name,
        enabled: account?.enabled !== false,
        configured: true,
      };
    };
    const accountHelpers = createAccountListHelpers("imessage");
    const raw: ChannelPlugin<ReturnType<typeof resolveRawAccount>> = {
      ...plugin("imessage", []),
      config: {
        ...createScopedChannelConfigAdapter({
          sectionKey: "imessage",
          listAccountIds: accountHelpers.listAccountIds,
          defaultAccountId: accountHelpers.resolveDefaultAccountId,
          resolveAccount: resolveRawAccount,
          clearBaseFields: [],
          resolveAllowFrom: () => [],
          formatAllowFrom: (values) => values.map(String),
        }),
        describeAccount: (account) => account,
      },
    };
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      inspected,
      prepared,
      unavailable,
      slack,
      unconfigured,
      custom,
      disabled,
      raw,
    ]);
    mocks.listExplicitConfiguredChannelIdsForConfig.mockReturnValue(["telegram", "feishu"]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockReturnValue([
      {
        channelId: "feishu",
        pluginId: "feishu",
        label: "Feishu",
        installSpec: "@openclaw/feishu",
        installCommand: "openclaw plugins install @openclaw/feishu",
        doctorFixCommand: "openclaw doctor --fix",
        repairHint,
      },
    ]);

    const statuses = await buildProviderStatusIndex(cfg);
    const metadata = buildProviderSummaryMetadataIndex(cfg);

    expect([...statuses].map(([key, entry]) => [key, entry.state, entry.configured])).toEqual([
      ["workchat:default", "linked", true],
      ["prepared:work", "configured", true],
      ["telegram:default", "configured unavailable", true],
      ["slack:optional", "configured", true],
      ["slack:missing", "not configured", false],
      ["slack:unavailable", "configured unavailable", true],
      ["quietchat:default", "not configured", false],
      ["legacychat:default", "enabled", true],
      ["disabledchat:default", "disabled", false],
      ["imessage:alpha", "configured", true],
      ["imessage:secret", "configured unavailable", true],
    ]);
    expect(statuses.get("workchat:default")).toMatchObject({ name: "Work", enabled: true });
    expect(statuses.get("prepared:work")).toMatchObject({ name: "Prepared", enabled: true });
    expect(statuses.get("imessage:alpha")).toMatchObject({ accountId: "alpha", name: "Exact" });
    expect(statuses.get("imessage:secret")).toMatchObject({
      accountId: "Secret",
      visibleInConfiguredLists: true,
    });
    expect(JSON.stringify([...statuses.values()])).not.toContain("PRIVATE_PROVIDER_TOKEN");
    expect(resolveAccount).not.toHaveBeenCalled();
    expect(inspectAccount).toHaveBeenCalledWith(cfg, "default");
    expect(isLinked).not.toHaveBeenCalled();
    expect(resolveAccountState).toHaveBeenCalledOnce();
    expect(calls).toEqual(raw.config.listAccountIds(cfg));
    expect(cfg.channels?.imessage?.accounts?.Alpha?.name).toBe("Alias");
    expect(metadata.get("feishu")).toEqual(missingMetadata);
    expect(mocks.resolveMissingOfficialExternalChannelPluginRepairHints).toHaveBeenCalledWith({
      config: cfg,
      channelIds: ["feishu"],
    });
    expect(mocks.listReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
      includeSetupFallbackPlugins: false,
    });
  });

  it("rethrows unexpected account resolution errors", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      plugin("quietchat", [{ accountId: "default" }], {
        resolveAccount: () => {
          throw new Error("plugin crash");
        },
      }),
    ]);
    await expect(buildProviderStatusIndex({})).rejects.toThrow("plugin crash");
  });

  it("renders canonical account scopes, deduplicating aliases without merging wildcard diagnostics", () => {
    mocks.normalizeChannelId.mockImplementation((value) =>
      typeof value === "string" && value !== "feishu" ? value : null,
    );
    const bindings = [
      route("telegram"),
      route("telegram", " \t "),
      route("telegram", "default"),
      route("telegram", " ALPHA "),
      route("telegram", " * "),
      route("telegram", "absent"),
      route("imessage", "*"),
      route("imessage", "alpha"),
      route("imessage", "Alpha"),
      route("signal", "*"),
      route("signal", "default"),
      route("feishu", "*"),
      route("feishu"),
    ];
    expect(summarizeBindings({}, bindings, displayMetadata)).toEqual([
      "Telegram default",
      "Telegram alpha",
      "Telegram *",
      "Telegram absent",
      "iMessage *",
      "iMessage alpha",
      "signal *",
      "signal default",
      "Feishu *",
      "Feishu default",
    ]);
    expect(
      listProvidersForAgent({
        summaryIsDefault: false,
        cfg: {},
        bindings,
        providerStatus: displayStatuses,
        providerMetadata: displayMetadata,
      }),
    ).toEqual([
      "telegram default (Default): not configured",
      "telegram alpha (Alpha): configured",
      "telegram beta (Beta): disabled",
      "Telegram absent: unknown",
      "imessage Alpha (Work): configured",
      "signal *: unknown",
      "signal default: unknown",
      "Feishu *: missing plugin - Install the official Feishu plugin.",
      "Feishu default: missing plugin - Install the official Feishu plugin.",
    ]);
  });

  it.each([false, true])("filters unbound inventory for default=%s", (summaryIsDefault) => {
    expect(
      listProvidersForAgent({
        summaryIsDefault,
        cfg: {},
        bindings: [],
        providerStatus: displayStatuses,
        providerMetadata: displayMetadata,
      }),
    ).toEqual(
      summaryIsDefault
        ? [
            "telegram alpha (Alpha): configured",
            "imessage Alpha (Work): configured",
            "Feishu default: missing plugin - Install the official Feishu plugin.",
          ]
        : [],
    );
  });
});
