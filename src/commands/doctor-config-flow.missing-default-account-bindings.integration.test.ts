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
  discord?: NonNullable<OpenClawConfig["channels"]>["discord"];
  bindings?: OpenClawConfig["bindings"];
  added?: OpenClawConfig["bindings"];
  sourceConfig?: unknown;
};

const routeBinding = (agentId: string, match: { guildId?: string; accountId?: string }) => ({
  agentId,
  match: { channel: "discord", ...match },
});
const legacyRoster = (...ids: string[]) => ({ agents: { list: ids.map((id) => ({ id })) } });
const ownershipCase = (name: string, overrides: Omit<OwnershipRepairCase, "name">) => ({
  name,
  ...overrides,
});

describe("doctor channel account ownership repair", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each<OwnershipRepairCase>([
    ownershipCase("explicit fleet does not inherit legacy list order", {
      sourceConfig: {
        agents: { ...legacyRoster("ops", "research").agents, ownership: "explicit" },
      },
    }),
    ownershipCase("legacy fallback preserves narrower route owners", {
      sourceConfig: legacyRoster("ops", "research"),
      bindings: [
        routeBinding("ops", { guildId: "guild-a" }),
        routeBinding("research", { guildId: "guild-b" }),
      ],
      added: [routeBinding("ops", { accountId: "default" })],
    }),
    ownershipCase("disabled default account alongside an active account", {
      sourceConfig: legacyRoster("research", "ops"),
      discord: { accounts: { default: { enabled: false }, work: {} } },
      bindings: [
        routeBinding("ops", { guildId: "guild-a" }),
        routeBinding("research", { accountId: "work", guildId: "guild-b" }),
      ],
      added: [routeBinding("research", { accountId: "work" })],
    }),
    ownershipCase("disabled channel", {
      discord: { enabled: false },
      bindings: [routeBinding("ops", { guildId: "guild-a" })],
    }),
    ownershipCase("unconfigured legacy main owner", {
      bindings: [routeBinding("main", { guildId: "guild-a" })],
    }),
    ownershipCase("blank owner even when main is configured", {
      agents: { ownership: "explicit", entries: { main: {}, research: {} } },
      bindings: [routeBinding("   ", { guildId: "guild-a" })],
    }),
  ])("repairs only proven ownership for $name", (testCase) => {
    const { discord = {}, bindings = [], added = [] } = testCase;
    vi.stubEnv("DISCORD_BOT_TOKEN", undefined);
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
