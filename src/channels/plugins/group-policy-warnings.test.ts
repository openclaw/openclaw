import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  collectAllowlistProviderRestrictSendersWarnings,
  composeAccountWarningCollectors,
  createAllowlistProviderRestrictSendersWarningCollector,
  createAllowlistProviderRouteAllowlistWarningCollector,
  createOpenGroupPolicyRestrictSendersWarningCollector,
  createOpenProviderConfiguredRouteWarningCollector,
  projectAccountConfigWarningCollector,
  projectAccountWarningCollector,
  projectConfigAccountIdWarningCollector,
  buildOpenGroupPolicyConfigureRouteAllowlistWarning,
  buildOpenGroupPolicyRestrictSendersWarning,
} from "./group-policy-warnings.js";

const restrictSenders = {
  surface: "Example groups",
  openScope: "any member",
  groupPolicyPath: "channels.example.groupPolicy",
  groupAllowFromPath: "channels.example.groupAllowFrom",
};
const configureRouteAllowlist = {
  surface: "Example channels",
  openScope: "any channel not explicitly denied",
  groupPolicyPath: "channels.example.groupPolicy",
  routeAllowlistPath: "channels.example.channels",
};
const missingRouteAllowlist = {
  surface: "Example channels",
  openBehavior: "with no route allowlist; any channel can trigger (mention-gated)",
  remediation:
    'Set channels.example.groupPolicy="allowlist" and configure channels.example.channels',
};
const accountPolicy = {
  providerConfigPresent: (cfg: OpenClawConfig) => cfg.channels?.example !== undefined,
  resolveGroupPolicy: (account: PolicyAccount) => account.groupPolicy,
};
type PolicyAccount = {
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, unknown>;
  channels?: Record<string, unknown>;
};
const routeWarnings = {
  restrictSenders: {
    surface: "Example groups",
    openScope: "any member in allowed groups",
    groupPolicyPath: "channels.example.groupPolicy",
    groupAllowFromPath: "channels.example.groupAllowFrom",
  },
  noRouteAllowlist: {
    surface: "Example groups",
    routeAllowlistPath: "channels.example.groups",
    routeScope: "group",
    groupPolicyPath: "channels.example.groupPolicy",
    groupAllowFromPath: "channels.example.groupAllowFrom",
  },
};
const openAccount = { groupPolicy: "open" } as const;
const exampleConfig = { channels: { example: {} } };
function withAccount<const T>(account: T) {
  return { account, cfg: exampleConfig };
}
const defaultOpenConfig = { channels: { defaults: { groupPolicy: "open" as const } } };

describe("group policy warning builders", () => {
  const input = {
    cfg: { channels: { slack: {} } },
    accountId: "acct-2",
    account: { accountId: "acct-1" },
  };
  type Input = typeof input;
  it.each([
    [
      "cfg+accountId",
      projectConfigAccountIdWarningCollector<Input>(({ accountId }) => [accountId ?? "default"]),
      ["acct-2"],
    ],
    [
      "account",
      projectAccountWarningCollector<Input["account"], Input>((account) => [account.accountId]),
      ["acct-1"],
    ],
    [
      "account+cfg",
      projectAccountConfigWarningCollector<Input["account"], Record<string, unknown>, Input>(
        (cfg) => cfg.channels ?? {},
        ({ account, cfg }) => [account.accountId, Object.keys(cfg).join(",") || "none"],
      ),
      ["acct-1", "slack"],
    ],
  ] as const)("projects %s warning collector inputs", (_name, collect, expected) => {
    expect(collect(input)).toEqual(expected);
  });

  it("composes account-scoped warning collectors", () => {
    const collect = composeAccountWarningCollectors<
      { enabled: boolean },
      { account: { enabled: boolean } }
    >(
      () => ["base"],
      (account) => (account.enabled ? "enabled" : undefined),
      () => ["extra-a", "extra-b"],
    );

    expect(collect({ account: { enabled: true } })).toEqual([
      "base",
      "enabled",
      "extra-a",
      "extra-b",
    ]);
    expect(collect({ account: { enabled: false } })).toEqual(["base", "extra-a", "extra-b"]);
  });

  it.each([false, true])("resolves runtime policy with provider=%s", (present) => {
    expect(
      collectAllowlistProviderRestrictSendersWarnings({
        cfg: defaultOpenConfig,
        providerConfigPresent: present,
        configuredGroupPolicy: present ? "open" : undefined,
        ...restrictSenders,
      }),
    ).toStrictEqual(present ? [buildOpenGroupPolicyRestrictSendersWarning(restrictSenders)] : []);
  });

  it("builds account-aware restrict-senders collectors", () => {
    const collect = createAllowlistProviderRestrictSendersWarningCollector<PolicyAccount>({
      ...accountPolicy,
      ...restrictSenders,
    });
    expect(collect(withAccount(openAccount))).toEqual([
      buildOpenGroupPolicyRestrictSendersWarning(restrictSenders),
    ]);
  });

  it.each([true, false])("builds route-allowlist collectors with routes=%s", (configured) => {
    const collectWarnings = createAllowlistProviderRouteAllowlistWarningCollector<PolicyAccount>({
      ...accountPolicy,
      resolveRouteAllowlistConfigured: (account) => Object.keys(account.groups ?? {}).length > 0,
      ...routeWarnings,
    });

    expect(
      collectWarnings(withAccount({ ...openAccount, groups: configured ? { general: true } : {} })),
    ).toEqual([
      configured
        ? buildOpenGroupPolicyRestrictSendersWarning(routeWarnings.restrictSenders)
        : '- Example groups: groupPolicy="open" with no channels.example.groups allowlist; any group can add + ping (mention-gated). Set channels.example.groupPolicy="allowlist" + channels.example.groupAllowFrom or configure channels.example.groups.',
    ]);
  });

  it("builds collectors for explicitly configured routes", () => {
    const collectWarnings = createOpenProviderConfiguredRouteWarningCollector<PolicyAccount>({
      ...accountPolicy,
      resolveRouteAllowlistConfigured: (account) => Object.keys(account.channels ?? {}).length > 0,
      configureRouteAllowlist,
      missingRouteAllowlist,
    });

    expect(collectWarnings(withAccount({ ...openAccount, channels: { general: true } }))).toEqual([
      buildOpenGroupPolicyConfigureRouteAllowlistWarning(configureRouteAllowlist),
    ]);
  });

  it("builds direct account-aware open-policy restrict-senders collectors", () => {
    const collectWarnings = createOpenGroupPolicyRestrictSendersWarningCollector<PolicyAccount>({
      resolveGroupPolicy: (account) => account.groupPolicy,
      defaultGroupPolicy: "allowlist",
      ...restrictSenders,
      mentionGated: false,
    });

    expect(collectWarnings({ groupPolicy: "allowlist" })).toStrictEqual([]);
    expect(collectWarnings({ groupPolicy: "open" })).toEqual([
      buildOpenGroupPolicyRestrictSendersWarning({
        ...restrictSenders,
        mentionGated: false,
      }),
    ]);
  });
});
