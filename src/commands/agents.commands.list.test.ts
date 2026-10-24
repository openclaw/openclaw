import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as channelExposure from "../channels/plugins/exposure.js";
import * as channelIds from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { AgentRouteBinding, IdentityConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAccountListHelpers } from "../plugin-sdk/account-helpers.js";
import { createScopedChannelConfigBase } from "../plugin-sdk/channel-config-helpers.js";
import * as configuredChannelIds from "../plugins/channel-plugin-ids.js";
import * as externalPluginRepairs from "../plugins/official-external-plugin-repair-hints.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { defaultRuntime } from "../runtime.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { withEnvAsync } from "../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  plugins: vi.fn<() => ChannelPlugin[]>(() => []),
  provenance: vi.fn(),
  displayProvenance: vi.fn(),
  config: vi.fn(),
}));

// mock-isolation: List fixture-owned configurations without reading operator state.
vi.mock("./config-validation.js", () => ({ requireValidConfig: mocks.config }));

// mock-isolation: Use synthetic plugin descriptors, retaining the command's real provider projection.
vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.plugins,
}));

// mock-isolation: Control provenance rows without opening the state database.
vi.mock("../state/agent-provenance.js", () => ({
  listAgentProvenance: mocks.provenance,
  readAgentProvenanceForDisplay: mocks.displayProvenance,
}));

const { agentsListCommand } = await import("./agents.commands.list.js");

async function list(options: Parameters<typeof agentsListCommand>[0]) {
  const log = vi.spyOn(defaultRuntime, "log").mockReturnValue(undefined).mockClear();
  const json = vi.spyOn(defaultRuntime, "writeJson").mockReturnValue(undefined).mockClear();
  await agentsListCommand(options);
  return {
    json: json.mock.calls[0]?.[0],
    text: log.mock.calls.flat().join("\n"),
  };
}

const telegramBinding = [{ agentId: "main", match: { channel: "telegram" } }];
const telegramPlugin = (label = "Telegram", name?: string) =>
  createChannelTestPluginBase({
    id: "telegram",
    label,
    config: {
      resolveAccount: () => ({ accountId: "default", enabled: true, configured: true }),
      describeAccount: () => ({ accountId: "default", enabled: true, configured: true, name }),
    },
  });
function setEntries(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  bindings?: OpenClawConfig["bindings"],
) {
  mocks.config.mockResolvedValue({ agents: { entries }, bindings } satisfies OpenClawConfig);
}

describe("agentsListCommand", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    setEntries({ main: {} }, telegramBinding);
    mocks.plugins.mockReturnValue([telegramPlugin()]);
    mocks.provenance.mockResolvedValue([]);
    mocks.displayProvenance.mockResolvedValue([]);
  });
  it("keeps the migrated default in JSON after reloading explicit ownership", async () => {
    const migrated = createCanonicalAgentConfigFixture({
      agents: { list: ["main", "research"].map((id) => ({ id, default: id === "research" })) },
    }).config;
    const persisted = structuredClone<OpenClawConfig>({
      ...migrated,
      agents: { ...migrated.agents, ownership: "explicit" },
    });
    for (const config of [migrated, persisted]) {
      mocks.config.mockResolvedValueOnce(config);
      expect((await list({ json: true })).json).toMatchObject([
        { id: "main", isDefault: false },
        { id: "research", isDefault: true },
      ]);
    }
  });
  it("adds durable provenance to JSON without loading provider details", async () => {
    mocks.provenance.mockRejectedValue(new Error("unrelated stored provenance is invalid"));
    mocks.displayProvenance.mockResolvedValue([
      { agentId: "main", createdVia: "operator", creatorAgentId: null, createdAtMs: 42 },
    ]);
    const { json } = await list({ json: true });
    expect(mocks.plugins).not.toHaveBeenCalled();
    expect(json).toMatchObject([
      { id: "main", createdVia: "operator", creatorAgentId: null, createdAt: 42 },
    ]);
    for (const field of ["routes", "providers"]) {
      expect(json).not.toHaveProperty(`0.${field}`);
    }
    await expect(list({ json: true, tree: true })).rejects.toThrow(
      "unrelated stored provenance is invalid",
    );
  });
  it("renders roots, children, missing and dangling creators with optional routing rules", async () => {
    setEntries(
      {
        main: { name: "Main" },
        child: { name: "Child" },
        legacy: { name: "Legacy" },
        orphan: { name: "Orphan" },
      },
      [{ agentId: "child", match: { channel: "telegram" } }],
    );
    mocks.provenance.mockResolvedValue([
      { agentId: "main", createdVia: "operator", creatorAgentId: null, createdAtMs: 1 },
      { agentId: "child", createdVia: "agent", creatorAgentId: "main", createdAtMs: 2 },
      { agentId: "orphan", createdVia: "agent", creatorAgentId: "deleted", createdAtMs: 3 },
    ]);
    expect((await list({ tree: true })).text).toBe(
      "Agents:\n- main (Main)\n  - child (Child)\n- legacy (Legacy)\n- orphan (Orphan)",
    );
    expect(mocks.plugins).not.toHaveBeenCalled();
    expect((await list({ tree: true, bindings: true })).text).toBe(
      "Agents:\n- main (Main)\n  - child (Child)\n    Routing rules:\n      - telegram\n- legacy (Legacy)\n- orphan (Orphan)",
    );
    expect((await list({ bindings: true })).text).toContain("    - telegram");
    expect((await list({ json: true, bindings: true })).json).toMatchObject([
      { id: "main" },
      { id: "child", bindingDetails: ["telegram"] },
      { id: "legacy" },
      { id: "orphan" },
    ]);
  });
  it("lists configured, inherited, and local avatar identities without changing the workspace", async () => {
    await withTestDir({ prefix: "openclaw-agent-identity-list-" }, async (workspace) => {
      const identityPath = path.join(workspace, "IDENTITY.md");
      const identityFile = "- Name: Workspace\n- Emoji: 🦞\n- Avatar: https://e.test/w.png\n";
      fs.writeFileSync(identityPath, identityFile);
      fs.writeFileSync(path.join(workspace, "avatar.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const agent = (identity: IdentityConfig) => ({ workspace, identity });
      setEntries({
        configured: agent({
          name: " Chosen ",
          emoji: "🦉",
          avatar: "https://e.test/n.png",
        }),
        partial: agent({ name: "Chosen" }),
        fallback: agent({ name: " ", emoji: "\t", avatar: "slack://avatar.png" }),
        local: agent({ avatar: "avatar.png" }),
        bare: { workspace: path.join(workspace, "empty") },
      });
      const { json } = await list({ json: true });
      expect(json).toMatchObject([
        ...[
          ["configured", "Chosen", "🦉", "https://e.test/n.png", "config"],
          ["partial", "Chosen", "🦞", "https://e.test/w.png", "config"],
          ["fallback", "Workspace", "🦞", "https://e.test/w.png", "identity"],
        ].map(([id, identityName, identityEmoji, identityAvatarUrl, identitySource]) => ({
          id,
          identityName,
          identityEmoji,
          identityAvatarUrl,
          identitySource,
        })),
        {
          id: "local",
          identityAvatarUrl: "data:image/png;base64,iVBORw==",
          identitySource: "config",
        },
        { id: "bare" },
      ]);
      expect(json).not.toHaveProperty("4.identityAvatarUrl");
      const { text: output } = await list({});
      expect(output).toContain("Identity: 🦉 Chosen (config)");
      expect(output).toContain("Identity: 🦞 Chosen (config)");
      expect(output).toContain("Identity: 🦞 Workspace (IDENTITY.md)");
      expect(fs.readFileSync(identityPath, "utf8")).toBe(identityFile);
    });
  });
  it("sanitizes configured agent text without changing JSON summaries", async () => {
    const control = "\u001B]0;agents-list-injection\u0007";
    const identityName = `${control}Operator 🦞\r\nforged-row`;
    const workspace = `/tmp/workspace-${control}\tpath`;
    const model = `${control}provider/model\nvariant`;
    setEntries(
      {
        main: {
          name: `${control}Main\nAlias`,
          workspace,
          agentDir: `/tmp/agent-${control}\npath`,
          model,
          identity: { name: identityName },
        },
      },
      telegramBinding,
    );
    mocks.plugins.mockReturnValue([
      telegramPlugin(`${control}Telegram\nroute`, `${control}Telegram\tconfigured`),
    ]);
    const { text: textOutput } = await list({ bindings: true });
    expect(textOutput).not.toContain("\u001B");
    expect(textOutput).not.toContain("\nforged-row");
    expect(textOutput).toContain("Operator 🦞\\r\\nforged-row");
    expect(textOutput).toContain("provider/model\\nvariant");
    expect(textOutput).toContain("Telegram\\nroute");
    expect((await list({ json: true })).json).toMatchObject([
      { identityName, model, workspace: expect.stringContaining(control) },
    ]);
  });
  it.skipIf(process.platform !== "win32")(
    "shortens real Windows home casing aliases in human output",
    async () => {
      await withTestDir({ prefix: "openclaw-home-display-" }, async (home) => {
        const workspace = path.join(home, "workspace");
        const agentDir = path.join(home, "agents", "main", "agent");
        await fs.promises.mkdir(workspace, { recursive: true });
        await fs.promises.mkdir(agentDir, { recursive: true });
        const homeAlias = home.toUpperCase();
        expect(fs.statSync(homeAlias).isDirectory()).toBe(true);
        setEntries({
          main: {
            workspace: path.join(homeAlias, "workspace"),
            agentDir: path.join(homeAlias, "agents", "main", "agent"),
          },
        });
        const { text: output } = await withEnvAsync({ OPENCLAW_HOME: home }, () => list({}));
        expect(output).toContain(`Workspace: $OPENCLAW_HOME${path.sep}workspace`);
        expect(output).toContain(
          `Agent dir: $OPENCLAW_HOME${path.sep}agents${path.sep}main${path.sep}agent`,
        );
        expect(output).not.toContain(homeAlias);
      });
    },
  );
});

type Plugin = ChannelPlugin<ChannelAccountSnapshot>;
const fail = (message: string): never => {
  throw new Error(message);
};
const providerMocks = {
  ...mocks,
  summaryIsDefault: true,
  normalize: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : null,
  ),
  configuredChannels: vi.fn<() => string[]>(() => []),
  repairs: vi.fn<
    typeof externalPluginRepairs.resolveMissingOfficialExternalChannelPluginRepairHints
  >(() => []),
};
async function listProviders(cfg: OpenClawConfig = {}, bindings: AgentRouteBinding[] = []) {
  mocks.config.mockResolvedValue({
    ...cfg,
    bindings,
    agents: {
      ownership: "explicit",
      ...(providerMocks.summaryIsDefault
        ? { defaults: { systemAgent: { agentId: "proof" } } }
        : {}),
      entries: { proof: { workspace: "/fixture", agentDir: "/fixture/agent" } },
    },
  });
  return (await list({ bindings: true, json: true })).json;
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
const feishuRepair: ReturnType<
  typeof externalPluginRepairs.resolveMissingOfficialExternalChannelPluginRepairHints
>[number] = {
  channelId: "feishu",
  pluginId: "feishu",
  label: "Feishu",
  installSpec: "@openclaw/feishu",
  installCommand: "openclaw plugins install @openclaw/feishu",
  doctorFixCommand: "openclaw doctor --fix",
  repairHint,
};
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
  providerMocks.plugins.mockReturnValue([telegram, imessage]);
  providerMocks.configuredChannels.mockReturnValue(["feishu"]);
  providerMocks.repairs.mockReturnValue([feishuRepair]);
}

describe("agent provider inventories", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(channelIds, "normalizeChannelId").mockImplementation(providerMocks.normalize);
    vi.spyOn(channelExposure, "isChannelVisibleInConfiguredLists").mockReturnValue(true);
    vi.spyOn(configuredChannelIds, "listExplicitConfiguredChannelIdsForConfig").mockImplementation(
      providerMocks.configuredChannels,
    );
    vi.spyOn(
      externalPluginRepairs,
      "resolveMissingOfficialExternalChannelPluginRepairHints",
    ).mockImplementation(providerMocks.repairs);
    mocks.provenance.mockResolvedValue([]);
    mocks.displayProvenance.mockResolvedValue([]);
    providerMocks.plugins.mockReturnValue([]);
    providerMocks.configuredChannels.mockReturnValue([]);
    providerMocks.repairs.mockReturnValue([]);
    providerMocks.normalize.mockReset();
    providerMocks.summaryIsDefault = true;
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
    providerMocks.plugins.mockReturnValue([
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
    providerMocks.configuredChannels.mockReturnValue(["telegram", "feishu"]);
    providerMocks.repairs.mockReturnValue([feishuRepair]);

    const bindings = providerMocks.plugins().map((entry) => route(entry.id, "*"));
    bindings.push(route("feishu"));
    providerMocks.plugins.mockClear();
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
    expect(providerMocks.repairs).toHaveBeenCalledWith({
      config: expect.objectContaining(cfg),
      channelIds: ["feishu"],
    });
    expect(providerMocks.plugins).toHaveBeenCalledOnce();
    expect(providerMocks.plugins).toHaveBeenCalledWith(expect.objectContaining(cfg), {
      includeSetupFallbackPlugins: false,
    });
  });

  it("rethrows unexpected account resolution errors", async () => {
    providerMocks.plugins.mockReturnValue([
      plugin("quietchat", {
        resolveAccount: () => fail("plugin crash"),
      }),
    ]);
    await expect(listProviders()).rejects.toThrow("plugin crash");
  });

  it("renders canonical account scopes, deduplicating aliases without merging wildcard diagnostics", async () => {
    providerMocks.normalize.mockImplementation((value) =>
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
    providerMocks.summaryIsDefault = summaryIsDefault;
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
