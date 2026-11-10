import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { maybeRepairGroupAllowFromFallback } from "./allowfrom-fallback-migration.js";

vi.mock("../channel-capabilities.js", () => ({
  getDoctorChannelCapabilities: (channelName?: string) => ({
    dmAllowFromMode: channelName === "matrix" ? "nestedOnly" : "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: channelName !== "discord",
    warnOnEmptyGroupSenderAllowlist: true,
  }),
}));
const migrate = (channels: OpenClawConfig["channels"]) =>
  maybeRepairGroupAllowFromFallback({ channels });
function expectUnchanged(channels: OpenClawConfig["channels"]) {
  expect(migrate(channels)).toEqual({ config: { channels }, changes: [] });
}

it.each([
  [
    "authored lists and inherited channel lists",
    {
      telegram: {
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        allowFrom: ["123"],
        accounts: {
          inherited: { allowFrom: ["456"] },
          explicit: { groupAllowFrom: [], allowFrom: ["789"] },
        },
      },
    },
  ],
  [
    "disabled scopes and unsupported fallback",
    {
      disabled: { enabled: false, allowFrom: ["user"] },
      telegram: { accounts: { disabled: { enabled: false, allowFrom: ["user"] } } },
      discord: { allowFrom: ["user"] },
      tools: { allowFrom: ["user"] },
    },
  ],
  [
    "schema without groupAllowFrom",
    { slack: { allowFrom: ["U123"], accounts: { workspace: { allowFrom: ["U456"] } } } },
  ],
  ["missing generated schema", { agentmail: { allowFrom: ["someone@example.com"] } }],
] satisfies Array<[string, OpenClawConfig["channels"]]>)("preserves %s", (_name, channels) =>
  expectUnchanged(channels),
);

it.each(["account", "channel", "defaults"] as const)("preserves disabled %s policy", (scope) => {
  expectUnchanged({
    ...(scope === "defaults" ? { defaults: { groupPolicy: "disabled" } } : {}),
    signal: {
      ...(scope === "channel" ? { groupPolicy: "disabled" } : {}),
      accounts: {
        work: {
          ...(scope === "account" ? { groupPolicy: "disabled" } : {}),
          allowFrom: ["work-user"],
        },
      },
    },
  });
});

it("applies policy overrides and normalizes fallback senders without mutating input", () => {
  const channels: OpenClawConfig["channels"] = {
    defaults: { groupPolicy: "disabled" },
    telegram: { groupPolicy: "allowlist", allowFrom: [123, "accessGroup:ops", "123"] },
    signal: {
      groupPolicy: "disabled",
      allowFrom: ["parent-user"],
      accounts: { work: { groupPolicy: "allowlist", allowFrom: ["work-user"] } },
    },
  };
  const result = migrate(channels);
  expect(result.config.channels?.telegram?.groupAllowFrom).toEqual(["123", "accessGroup:ops"]);
  expect(result.config.channels?.signal?.groupAllowFrom).toBeUndefined();
  expect(result.config.channels?.signal?.accounts?.work?.groupAllowFrom).toEqual(["work-user"]);
  expect(maybeRepairGroupAllowFromFallback(result.config).changes).toEqual([]);
  expect(channels.telegram?.groupAllowFrom).toBeUndefined();
});

it("preserves account-scoped fallback without broadening to the channel", () => {
  const result = migrate({
    signal: {
      allowFrom: ["parent"],
      accounts: {
        work: { allowFrom: ["work-user"] },
        personal: { groupAllowFrom: ["personal-user"], allowFrom: ["ignored"] },
      },
    },
  });
  expect(result.config.channels?.signal).toMatchObject({
    groupAllowFrom: ["parent"],
    accounts: {
      work: { groupAllowFrom: ["work-user"] },
      personal: { groupAllowFrom: ["personal-user"] },
    },
  });
  expect(result.changes).toHaveLength(2);
});
