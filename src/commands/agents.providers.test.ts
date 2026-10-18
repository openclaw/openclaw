import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { AgentRouteBinding, OpenClawConfig } from "../config/types.js";
import { createAccountListHelpers } from "../plugin-sdk/account-helpers.js";
import { createScopedChannelConfigBase } from "../plugin-sdk/channel-config-helpers.js";
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
const fail = (message: string): never => {
  throw new Error(message);
};
const mocks = vi.hoisted(() => ({
  plugins: vi.fn<() => ChannelPlugin[]>(() => []),
  normalize: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : null,
  ),
  defaultAccount: vi.fn(() => "default"),
  visible: vi.fn(() => true),
  configuredChannels: vi.fn<() => string[]>(() => []),
  repairs: vi.fn<() => OfficialExternalPluginRepairHint[]>(() => []),
}));
// mock-isolation: Resolve synthetic channel IDs without loading plugin runtimes.
vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: mocks.normalize,
  getChannelPlugin: vi.fn(),
}));
// mock-isolation: Use fixture-owned plugin descriptors instead of the installed registry.
vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.plugins,
}));
// mock-isolation: Control the synthetic default account independently of installed plugins.
vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: mocks.defaultAccount,
}));
// mock-isolation: Exercise both visibility decisions with synthetic plugin metadata.
vi.mock("../channels/plugins/exposure.js", () => ({
  isChannelVisibleInConfiguredLists: mocks.visible,
}));
// mock-isolation: Control configured channel inventory without plugin discovery.
vi.mock("../plugins/channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: mocks.configuredChannels,
}));
// mock-isolation: Supply synthetic repair hints without reading installed plugin state.
vi.mock("../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints: mocks.repairs,
}));

const plugin = (
  id: string,
  config: Partial<Plugin["config"]> = {},
  accounts: ChannelAccountSnapshot[] = [{ accountId: "default" }],
): Plugin => ({
  id,
  meta: { id, label: id, selectionLabel: id, docsPath: `/channels/${id}`, blurb: "Fixture" },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => accounts.map((account) => account.accountId),
    resolveAccount: (_cfg, accountId) =>
      accounts.find((entry) => entry.accountId === (accountId ?? "default")) ??
      fail("Unexpected fixture account"),
    describeAccount: (account) => account,
    ...config,
  },
});
const makeAccount = (accountId: string, fields: Partial<ChannelAccountSnapshot> = {}) => ({
  accountId,
  enabled: true,
  configured: true,
  ...fields,
});
const repairHint = "Install the official Feishu plugin.";
const defaultMetadata = { defaultAccountId: "default", visibleInConfiguredLists: true };
const missingMetadata = { ...defaultMetadata, label: "Feishu", repairHint };
const route = (channel: string, accountId?: string): AgentRouteBinding => ({
  agentId: "proof",
  match: { channel, accountId },
});
type DisplayState = "configured" | "not configured" | "disabled";
const display = (provider: string, accountId: string, name: string, state: DisplayState) => ({
  provider,
  accountId,
  name,
  state,
  configured: state === "configured",
  enabled: state !== "disabled",
  visibleInConfiguredLists: true,
});
const displayStatuses: Awaited<ReturnType<typeof buildProviderStatusIndex>> = new Map([
  ["telegram:default", display("telegram", "default", "Default", "not configured")],
  ["telegram:alpha", display("telegram", "alpha", "Alpha", "configured")],
  ["telegram:beta", display("telegram", "beta", "Beta", "disabled")],
  ["imessage:alpha", display("imessage", "Alpha", "Work", "configured")],
]);
type MetadataEntry = Parameters<ReturnType<typeof buildProviderSummaryMetadataIndex>["set"]>;
const displayMetadata = new Map<MetadataEntry[0], MetadataEntry[1]>([
  ["telegram", { ...defaultMetadata, label: "Telegram", defaultAccountId: "alpha" }],
  ["imessage", { ...defaultMetadata, label: "iMessage" }],
  ["feishu", missingMetadata],
]);
const listDisplayProviders = (bindings: AgentRouteBinding[], summaryIsDefault = false) =>
  listProvidersForAgent({
    summaryIsDefault,
    cfg: {},
    bindings,
    providerStatus: displayStatuses,
    providerMetadata: displayMetadata,
  });

describe("agent provider inventories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.plugins.mockReturnValue([]);
    mocks.configuredChannels.mockReturnValue([]);
    mocks.repairs.mockReturnValue([]);
    mocks.normalize.mockReset();
  });

  it("builds a read-only mixed account inventory without exposing unavailable credentials", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: { accounts: { Alpha: { name: "Alias" }, alpha: { name: "Exact" }, Secret: {} } },
      },
    };
    const inspectAccount = vi.fn(() => makeAccount("default", { linked: true, name: "Work" }));
    const resolveAccount = vi.fn(() => fail("must inspect read-only accounts"));
    const isLinked = vi.fn(() => fail("linkage unavailable"));
    const resolveAccountState = vi.fn(() => "enabled" as const);
    const calls: Array<string | null | undefined> = [];
    const resolveRawAccount = (config: OpenClawConfig, requestedId?: string | null) => {
      calls.push(requestedId);
      if (requestedId === "Secret") {
        throw new Error("unresolved SecretRef: PRIVATE_PROVIDER_TOKEN");
      }
      const accountId = normalizeAccountId(requestedId);
      const account = resolveAccountEntry(config.channels?.imessage?.accounts, accountId);
      return makeAccount(accountId, { name: account?.name, enabled: account?.enabled !== false });
    };
    const accountHelpers = createAccountListHelpers("imessage");
    const raw = plugin(
      "imessage",
      createScopedChannelConfigBase({
        sectionKey: "imessage",
        listAccountIds: accountHelpers.listAccountIds,
        defaultAccountId: accountHelpers.resolveDefaultAccountId,
        resolveAccount: resolveRawAccount,
        clearBaseFields: [],
      }),
      [],
    );
    mocks.plugins.mockReturnValue([
      plugin("workchat", { inspectAccount, resolveAccount }),
      plugin(
        "prepared",
        {
          resolveAccount,
          resolveAccountAsync: async () => makeAccount("work", { name: "Prepared" }),
        },
        [{ accountId: "work" }],
      ),
      plugin("telegram", { isConfigured: () => false }, [
        makeAccount("default", { tokenStatus: "configured_unavailable" }),
      ]),
      plugin(
        "slack",
        {
          isConfigured: (account) => account.accountId === "optional",
          describeAccount: (account) =>
            makeAccount(account.accountId, { configured: account.accountId !== "unavailable" }),
        },
        [
          makeAccount("optional", { userTokenStatus: "configured_unavailable" }),
          makeAccount("missing", {
            configured: false,
            botTokenStatus: "configured_unavailable",
            appTokenStatus: "missing",
          }),
          makeAccount("unavailable", {
            botTokenStatus: "configured_unavailable",
            appTokenStatus: "available",
          }),
        ],
      ),
      plugin("quietchat", { describeAccount: undefined, isConfigured: () => false, isLinked }, [
        { accountId: "default", enabled: true },
      ]),
      {
        ...plugin("legacychat", { describeAccount: undefined, isConfigured: () => true }, [
          makeAccount("default"),
        ]),
        status: { resolveAccountState },
      },
      plugin("disabledchat", {}, [makeAccount("default", { enabled: false, configured: false })]),
      raw,
    ]);
    mocks.configuredChannels.mockReturnValue(["telegram", "feishu"]);
    mocks.repairs.mockReturnValue([
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
    expect(mocks.repairs).toHaveBeenCalledWith({
      config: cfg,
      channelIds: ["feishu"],
    });
    expect(mocks.plugins).toHaveBeenCalledWith(cfg, {
      includeSetupFallbackPlugins: false,
    });
  });

  it("rethrows unexpected account resolution errors", async () => {
    mocks.plugins.mockReturnValue([
      plugin("quietchat", {
        resolveAccount: () => fail("plugin crash"),
      }),
    ]);
    await expect(buildProviderStatusIndex({})).rejects.toThrow("plugin crash");
  });

  it("renders canonical account scopes, deduplicating aliases without merging wildcard diagnostics", () => {
    mocks.normalize.mockImplementation((value) =>
      typeof value === "string" && value !== "feishu" ? value : null,
    );
    const bindings = [
      ...[undefined, " \t ", "default", " ALPHA ", " * ", "absent"].map((id) =>
        route("telegram", id),
      ),
      ...["*", "alpha", "Alpha"].map((id) => route("imessage", id)),
      ...["*", "default"].map((id) => route("signal", id)),
      ...["*", undefined].map((id) => route("feishu", id)),
    ];
    expect(summarizeBindings({}, bindings, displayMetadata)).toEqual([
      ...["default", "alpha", "*", "absent"].map((id) => `Telegram ${id}`),
      ...["*", "alpha"].map((id) => `iMessage ${id}`),
      ...["signal", "Feishu"].flatMap((label) => ["*", "default"].map((id) => `${label} ${id}`)),
    ]);
    expect(listDisplayProviders(bindings)).toEqual([
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
    expect(listDisplayProviders([], summaryIsDefault)).toEqual(
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
