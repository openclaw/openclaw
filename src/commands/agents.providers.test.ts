import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { AgentRouteBinding, OpenClawConfig } from "../config/types.js";
import { createAccountListHelpers } from "../plugin-sdk/account-helpers.js";
import { createScopedChannelConfigBase } from "../plugin-sdk/channel-config-helpers.js";
import type { OfficialExternalPluginRepairHint } from "../plugins/official-external-plugin-repair-hints.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { agentsListCommand } from "./agents.commands.list.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

type Plugin = ChannelPlugin<ChannelAccountSnapshot>;
const fail = (message: string): never => {
  throw new Error(message);
};
const mocks = vi.hoisted(() => ({
  plugins: vi.fn<() => ChannelPlugin[]>(() => []),
  config: vi.fn<() => Promise<OpenClawConfig>>(),
  summaryIsDefault: true,
  normalize: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : null,
  ),
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

// mock-isolation: Provider output uses fixture-owned config, roster and provenance, not operator state.
vi.mock("./config-validation.js", () => ({ requireValidConfig: mocks.config }));
// mock-isolation: Account output is independent of roster identity/workspace I/O.
vi.mock("./agents.config.js", () => ({
  buildAgentSummaries: async () => [
    {
      id: "proof",
      workspace: "/fixture",
      agentDir: "/fixture/agent",
      bindings: 0,
      isDefault: mocks.summaryIsDefault,
    },
  ],
}));
// mock-isolation: Fixture roster is already admitted; do not open state databases.
vi.mock("../state/agent-database-admission.js", () => ({
  hasAgentDatabaseAdmissions: () => true,
  evaluateAgentDatabaseAdmissions: async () => [],
  recordAgentDatabaseAdmissions: () => undefined,
}));
// mock-isolation: Fixture roster has no persisted provenance or operator database.
vi.mock("../state/agent-provenance.js", () => ({
  listAgentProvenance: async () => [],
  readAgentProvenanceForDisplay: async () => [],
}));

async function listProviders(cfg: OpenClawConfig = {}, bindings: AgentRouteBinding[] = []) {
  mocks.config.mockResolvedValue({ ...cfg, bindings });
  const runtime = {
    ...createTestRuntime(),
    writeStdout: vi.fn(),
    writeJson: vi.fn<(value: unknown) => void>(),
  };
  await agentsListCommand({ bindings: true, json: true }, runtime);
  return runtime.writeJson.mock.calls[0]?.[0];
}

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
const route = (channel: string, accountId?: string): AgentRouteBinding => ({
  agentId: "proof",
  match: { channel, accountId },
});
function configureDisplayPlugins() {
  const telegram = plugin("telegram", {}, [
    makeAccount("default", { name: "Default", configured: false }),
    makeAccount("alpha", { name: "Alpha" }),
    makeAccount("beta", { name: "Beta", enabled: false, configured: false }),
  ]);
  telegram.meta.label = "Telegram";
  const imessage = plugin("imessage", {}, [makeAccount("Alpha", { name: "Work" })]);
  imessage.meta.label = "iMessage";
  mocks.plugins.mockReturnValue([telegram, imessage]);
  mocks.configuredChannels.mockReturnValue(["feishu"]);
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
}

describe("agent provider inventories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.plugins.mockReturnValue([]);
    mocks.configuredChannels.mockReturnValue([]);
    mocks.repairs.mockReturnValue([]);
    mocks.normalize.mockReset();
    mocks.summaryIsDefault = true;
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

    const bindings = mocks.plugins().map((entry) => route(entry.id, "*"));
    bindings.push(route("feishu"));
    mocks.plugins.mockClear();
    const output = await listProviders(cfg, bindings);
    expect(output).toMatchObject([
      {
        providers: [
          "workchat default (Work): linked",
          "prepared work (Prepared): configured",
          "telegram default: configured unavailable",
          "slack optional: configured",
          "slack missing: not configured",
          "slack unavailable: configured unavailable",
          "quietchat default: not configured",
          "legacychat default: enabled",
          "disabledchat default: disabled",
          "imessage alpha (Exact): configured",
          "imessage Secret: configured unavailable",
          "Feishu default: missing plugin - Install the official Feishu plugin.",
        ],
      },
    ]);
    expect(JSON.stringify(output)).not.toContain("PRIVATE_PROVIDER_TOKEN");
    expect(resolveAccount).not.toHaveBeenCalled();
    expect(inspectAccount).toHaveBeenCalledWith(expect.objectContaining(cfg), "default");
    expect(isLinked).not.toHaveBeenCalled();
    expect(resolveAccountState).toHaveBeenCalledOnce();
    expect(calls).toEqual(raw.config.listAccountIds(cfg));
    expect(cfg.channels?.imessage?.accounts?.Alpha?.name).toBe("Alias");
    expect(mocks.repairs).toHaveBeenCalledWith({
      config: expect.objectContaining(cfg),
      channelIds: ["feishu"],
    });
    expect(mocks.plugins).toHaveBeenCalledOnce();
    expect(mocks.plugins).toHaveBeenCalledWith(expect.objectContaining(cfg), {
      includeSetupFallbackPlugins: false,
    });
  });

  it("rethrows unexpected account resolution errors", async () => {
    mocks.plugins.mockReturnValue([
      plugin("quietchat", {
        resolveAccount: () => fail("plugin crash"),
      }),
    ]);
    await expect(listProviders()).rejects.toThrow("plugin crash");
  });

  it("renders canonical account scopes, deduplicating aliases without merging wildcard diagnostics", async () => {
    mocks.normalize.mockImplementation((value) =>
      typeof value === "string" && value !== "feishu" ? value : null,
    );
    configureDisplayPlugins();
    const bindings = [
      ...[undefined, " \t ", "default", " ALPHA ", " * ", "absent"].map((id) =>
        route("telegram", id),
      ),
      ...["*", "alpha", "Alpha"].map((id) => route("imessage", id)),
      ...["*", "default"].map((id) => route("signal", id)),
      ...["*", undefined].map((id) => route("feishu", id)),
    ];
    expect(await listProviders({}, bindings)).toMatchObject([
      {
        routes: [
          ...["default", "alpha", "*", "absent"].map((id) => `Telegram ${id}`),
          ...["*", "alpha"].map((id) => `iMessage ${id}`),
          ...["signal", "Feishu"].flatMap((label) =>
            ["*", "default"].map((id) => `${label} ${id}`),
          ),
        ],
        providers: [
          "Telegram default (Default): not configured",
          "Telegram alpha (Alpha): configured",
          "Telegram beta (Beta): disabled",
          "Telegram absent: unknown",
          "iMessage Alpha (Work): configured",
          "signal *: unknown",
          "signal default: unknown",
          "Feishu *: missing plugin - Install the official Feishu plugin.",
          "Feishu default: missing plugin - Install the official Feishu plugin.",
        ],
      },
    ]);
  });

  it.each([false, true])("filters unbound inventory for default=%s", async (summaryIsDefault) => {
    mocks.summaryIsDefault = summaryIsDefault;
    configureDisplayPlugins();
    const output = await listProviders();
    expect(output).toMatchObject([
      summaryIsDefault
        ? {
            providers: [
              "Telegram alpha (Alpha): configured",
              "iMessage Alpha (Work): configured",
              "Feishu default: missing plugin - Install the official Feishu plugin.",
            ],
          }
        : { id: "proof" },
    ]);
    if (!summaryIsDefault) {
      expect(output).not.toHaveProperty("0.providers");
    }
  });
});
