import { afterEach, expect, it, vi } from "vitest";
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
afterEach(() => vi.unstubAllEnvs());

const binding = (agentId: string, match: { guildId?: string; accountId?: string }) => ({
  agentId,
  match: { channel: "discord", ...match },
});
const legacy = (ids: string[], explicit = false) => ({
  agents: { list: ids.map((id) => ({ id })), ...(explicit ? { ownership: "explicit" } : {}) },
});
const narrow = [
  binding("ops", { guildId: "guild-a" }),
  binding("research", { guildId: "guild-b" }),
];
function scenario(
  name: string,
  discord: NonNullable<OpenClawConfig["channels"]>["discord"],
  bindings: NonNullable<OpenClawConfig["bindings"]> = [],
  sourceConfig?: unknown,
  added: typeof bindings = [],
) {
  const config: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    channels: { discord },
    bindings,
  };
  return { name, config, sourceConfig, added };
}

it.each([
  scenario("explicit fleet", {}, [], legacy(["ops", "research"], true)),
  scenario("legacy fallback", {}, narrow, legacy(["ops", "research"]), [
    binding("ops", { accountId: "default" }),
  ]),
  scenario(
    "disabled default beside an active account",
    { accounts: { default: { enabled: false }, work: {} } },
    [narrow[0]!, binding("research", { accountId: "work", guildId: "guild-b" })],
    legacy(["research", "ops"]),
    [binding("research", { accountId: "work" })],
  ),
  scenario("disabled channel", { enabled: false }, [narrow[0]!]),
  scenario("unconfigured legacy main owner", {}, [binding("main", { guildId: "guild-a" })]),
])("repairs only proven ownership for $name", ({ name, config, sourceConfig, added }) => {
  vi.stubEnv("DISCORD_BOT_TOKEN", undefined);
  const repair = (input: OpenClawConfig) =>
    repairUnownedChannelAccountBindings({
      config: input,
      sourceConfigBeforeMigrations: sourceConfig,
    });
  const repaired = repair(config);
  expect(repaired.config.bindings).toEqual([...config.bindings!, ...added]);
  if (name === "legacy fallback") {
    expect(
      resolveAgentRoute({
        cfg: repaired.config,
        channel: "discord",
        guildId: "guild-b",
      }).agentId,
    ).toBe("research");
  }
  if (name === "explicit fleet") {
    expect(repaired.warnings?.join("\n")).toContain(
      '{"agentId":"<agentId>","match":{"channel":"discord","accountId":"default"}}',
    );
  }
  const second = repair(repaired.config);
  expect(second.config).toBe(repaired.config);
  expect(second.changes).toEqual([]);
});
