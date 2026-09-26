// Doctor account ownership repairs preserve route resolution across realistic config shapes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { repairUnownedChannelAccountBindings } from "./doctor/shared/legacy-config-binding-repair.js";

vi.mock("../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: () => {
    const { listAccountIds } = createAccountListHelpers("discord", {
      implicitDefaultAccount: { channelKeys: ["token"], envVars: ["DISCORD_BOT_TOKEN"] },
    });
    return {
      configuredChannelIds: ["discord"],
      plugins: [{ id: "discord", config: { listAccountIds } }],
    };
  },
}));

type OwnershipRepairCase = {
  name: string;
  agents?: OpenClawConfig["agents"];
  envToken?: boolean;
  discord: NonNullable<OpenClawConfig["channels"]>["discord"];
  bindings: NonNullable<OpenClawConfig["bindings"]>;
  added: NonNullable<OpenClawConfig["bindings"]>;
  sourceConfig?: unknown;
};

describe("doctor channel account ownership repair", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each<OwnershipRepairCase>([
    {
      name: "unbound legacy account preserves its first agent",
      sourceConfig: { agents: { list: [{ id: "ops" }, { id: "research" }] } },
      discord: {},
      bindings: [],
      added: [{ agentId: "ops", match: { channel: "discord", accountId: "default" } }],
    },
    {
      name: "legacy owner precedes inferred narrower ownership",
      sourceConfig: { agents: { list: [{ id: "ops" }, { id: "research" }] } },
      discord: {},
      bindings: [{ agentId: "research", match: { channel: "discord", guildId: "guild-b" } }],
      added: [{ agentId: "ops", match: { channel: "discord", accountId: "default" } }],
    },
    {
      name: "normalized legacy agent id",
      sourceConfig: { agents: { list: [{ id: "Ops" }, { id: "research" }] } },
      discord: {},
      bindings: [],
      added: [{ agentId: "ops", match: { channel: "discord", accountId: "default" } }],
    },
    {
      name: "explicit fleet does not inherit legacy list order",
      sourceConfig: {
        agents: { ownership: "explicit", list: [{ id: "ops" }, { id: "research" }] },
      },
      discord: {},
      bindings: [],
      added: [],
    },
    {
      name: "legacy fallback preserves narrower route owners",
      sourceConfig: { agents: { list: [{ id: "ops" }, { id: "research" }] } },
      discord: {},
      bindings: [
        { agentId: "ops", match: { channel: "discord", guildId: "guild-a" } },
        { agentId: "research", match: { channel: "discord", guildId: "guild-b" } },
      ],
      added: [{ agentId: "ops", match: { channel: "discord", accountId: "default" } }],
    },
    {
      name: "implicit default account with historical ownership",
      sourceConfig: { agents: { list: [{ id: "ops" }, { id: "research" }] } },
      discord: {},
      bindings: [{ agentId: "ops", match: { channel: "discord", guildId: "guild-a" } }],
      added: [{ agentId: "ops", match: { channel: "discord", accountId: "default" } }],
    },
    {
      name: "named account without widening other account or guild owners",
      sourceConfig: { agents: { list: [{ id: "ops" }, { id: "research" }] } },
      discord: { accounts: { alerts: {}, work: {} } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", accountId: "alerts", guildId: "guild-a" } },
        { agentId: "ops", match: { channel: "discord", accountId: "alerts", guildId: "guild-b" } },
        { agentId: "research", match: { channel: "discord", accountId: "work" } },
      ],
      added: [{ agentId: "ops", match: { channel: "discord", accountId: "alerts" } }],
    },
    {
      name: "environment-only default account alongside a named account",
      sourceConfig: { agents: { list: [{ id: "ops" }, { id: "research" }] } },
      envToken: true,
      discord: { accounts: { alerts: {} } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", accountId: "*", guildId: "guild-a" } },
      ],
      added: [
        { agentId: "ops", match: { channel: "discord", accountId: "alerts" } },
        { agentId: "ops", match: { channel: "discord", accountId: "default" } },
      ],
    },
    {
      name: "root-token default account alongside a named account",
      sourceConfig: { agents: { list: [{ id: "ops" }, { id: "research" }] } },
      discord: { token: "synthetic-discord-token", accounts: { alerts: {} } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", accountId: "*", guildId: "guild-a" } },
      ],
      added: [
        { agentId: "ops", match: { channel: "discord", accountId: "alerts" } },
        { agentId: "ops", match: { channel: "discord", accountId: "default" } },
      ],
    },
    {
      name: "historical ownership without inventing a default account",
      sourceConfig: { agents: { list: [{ id: "ops" }, { id: "research" }] } },
      discord: { accounts: { alerts: {}, work: { enabled: false } } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", accountId: "*", guildId: "guild-a" } },
      ],
      added: [{ agentId: "ops", match: { channel: "discord", accountId: "alerts" } }],
    },
    {
      name: "disabled default account alongside an active account",
      sourceConfig: { agents: { list: [{ id: "research" }, { id: "ops" }] } },
      discord: { accounts: { default: { enabled: false }, work: {} } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", guildId: "guild-a" } },
        {
          agentId: "research",
          match: { channel: "discord", accountId: "work", guildId: "guild-b" },
        },
      ],
      added: [{ agentId: "research", match: { channel: "discord", accountId: "work" } }],
    },
    {
      name: "disabled channel",
      discord: { enabled: false },
      bindings: [{ agentId: "ops", match: { channel: "discord", guildId: "guild-a" } }],
      added: [],
    },
    {
      name: "unconfigured legacy main owner",
      discord: {},
      bindings: [{ agentId: "main", match: { channel: "discord", guildId: "guild-a" } }],
      added: [],
    },
    {
      name: "blank owner even when main is configured",
      agents: { ownership: "explicit", entries: { main: {}, research: {} } },
      discord: {},
      bindings: [{ agentId: "   ", match: { channel: "discord", guildId: "guild-a" } }],
      added: [],
    },
    {
      name: "empty peer that cannot match a route",
      discord: {},
      bindings: [
        { agentId: "ops", match: { channel: "discord", peer: { kind: "direct", id: " " } } },
      ],
      added: [],
    },
    {
      name: "ambiguous guild owners",
      discord: {},
      bindings: [
        { agentId: "ops", match: { channel: "discord", guildId: "guild-a" } },
        { agentId: "research", match: { channel: "discord", guildId: "guild-b" } },
      ],
      added: [],
    },
    {
      name: "missing owner despite bindings on another account and channel",
      discord: { accounts: { default: {}, work: {} } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", accountId: "work" } },
        { agentId: "ops", match: { channel: "telegram", accountId: "default" } },
      ],
      added: [],
    },
    {
      name: "existing channel-wide route",
      discord: { accounts: { default: {}, work: {} } },
      bindings: [
        { agentId: "research", match: { channel: "discord", accountId: "*" } },
        { agentId: "ops", match: { channel: "discord", guildId: "guild-a" } },
      ],
      added: [],
    },
  ])("repairs only proven ownership for $name", (testCase) => {
    const { discord, bindings, added } = testCase;
    vi.stubEnv(
      "DISCORD_BOT_TOKEN",
      "envToken" in testCase && testCase.envToken ? "synthetic-discord-token" : undefined,
    );
    const config: OpenClawConfig = {
      agents: testCase.agents ?? { ownership: "explicit", entries: { ops: {}, research: {} } },
      channels: { discord },
      bindings,
    };
    const repaired = repairUnownedChannelAccountBindings({
      config,
      sourceConfigBeforeMigrations: testCase.sourceConfig,
    });
    expect(repaired.config.bindings).toEqual([...bindings, ...added]);
    for (const binding of added) {
      expect(resolveAgentRoute({ cfg: repaired.config, ...binding.match }).agentId).toBe(
        binding.agentId,
      );
    }
    if (testCase.name === "legacy fallback preserves narrower route owners") {
      expect(
        resolveAgentRoute({ cfg: repaired.config, channel: "discord", guildId: "guild-b" }).agentId,
      ).toBe("research");
    }
    if (testCase.name === "explicit fleet does not inherit legacy list order") {
      expect(repaired.warnings?.join("\n")).toContain(
        '{"agentId":"<agentId>","match":{"channel":"discord","accountId":"default"}}',
      );
    }
    const secondPass = repairUnownedChannelAccountBindings({
      config: repaired.config,
      sourceConfigBeforeMigrations: testCase.sourceConfig,
    });
    expect(secondPass.config).toBe(repaired.config);
    expect(secondPass.changes).toEqual([]);
  });
});
