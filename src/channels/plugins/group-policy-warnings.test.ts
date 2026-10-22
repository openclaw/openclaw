import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  collectAllowlistProviderRestrictSendersWarnings,
  composeAccountWarningCollectors,
  createAllowlistProviderGroupPolicyWarningCollector,
  createAllowlistProviderOpenWarningCollector,
  createAllowlistProviderRestrictSendersWarningCollector,
  createAllowlistProviderRouteAllowlistWarningCollector,
  createOpenGroupPolicyRestrictSendersWarningCollector,
  createOpenProviderGroupPolicyWarningCollector,
  createOpenProviderConfiguredRouteWarningCollector,
  projectAccountConfigWarningCollector,
  projectAccountWarningCollector,
  projectConfigAccountIdWarningCollector,
  collectOpenGroupPolicyConfiguredRouteWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  buildOpenGroupPolicyConfigureRouteAllowlistWarning,
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
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
type PolicyAccount = { groupPolicy?: "open" | "allowlist" | "disabled" };
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
const openWarning = {
  ...missingRouteAllowlist,
  openBehavior: "allows any channel to trigger (mention-gated)",
};
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

  it("resolves allowlist-provider runtime policy before collecting restrict-senders warnings", () => {
    expect(
      collectAllowlistProviderRestrictSendersWarnings({
        cfg: defaultOpenConfig,
        providerConfigPresent: false,
        configuredGroupPolicy: undefined,
        ...restrictSenders,
      }),
    ).toStrictEqual([]);

    expect(
      collectAllowlistProviderRestrictSendersWarnings({
        cfg: defaultOpenConfig,
        providerConfigPresent: true,
        configuredGroupPolicy: "open",
        ...restrictSenders,
      }),
    ).toEqual([buildOpenGroupPolicyRestrictSendersWarning(restrictSenders)]);
  });

  it("collects route allowlist warning variants", () => {
    const params = {
      groupPolicy: "open" as const,
      ...routeWarnings,
    };

    expect(
      collectOpenGroupPolicyRouteAllowlistWarnings({
        ...params,
        routeAllowlistConfigured: true,
      }),
    ).toEqual([buildOpenGroupPolicyRestrictSendersWarning(params.restrictSenders)]);

    expect(
      collectOpenGroupPolicyRouteAllowlistWarnings({
        ...params,
        routeAllowlistConfigured: false,
      }),
    ).toEqual([
      '- Example groups: groupPolicy="open" with no channels.example.groups allowlist; any group can add + ping (mention-gated). Set channels.example.groupPolicy="allowlist" + channels.example.groupAllowFrom or configure channels.example.groups.',
    ]);
  });

  it("collects configured-route warning variants", () => {
    const params = {
      groupPolicy: "open" as const,
      configureRouteAllowlist,
      missingRouteAllowlist,
    };

    expect(
      collectOpenGroupPolicyConfiguredRouteWarnings({
        ...params,
        routeAllowlistConfigured: true,
      }),
    ).toEqual([buildOpenGroupPolicyConfigureRouteAllowlistWarning(params.configureRouteAllowlist)]);

    expect(
      collectOpenGroupPolicyConfiguredRouteWarnings({
        ...params,
        routeAllowlistConfigured: false,
      }),
    ).toEqual([buildOpenGroupPolicyWarning(params.missingRouteAllowlist)]);
  });

  it("builds account-aware allowlist-provider restrict-senders collectors", () => {
    const collectWarnings = createAllowlistProviderRestrictSendersWarningCollector<PolicyAccount>({
      ...accountPolicy,
      ...restrictSenders,
    });

    expect(collectWarnings(withAccount({ groupPolicy: "open" }))).toEqual([
      buildOpenGroupPolicyRestrictSendersWarning(restrictSenders),
    ]);
  });

  type ConfigInput = {
    cfg: OpenClawConfig;
    channelLabel: string;
    configuredGroupPolicy?: PolicyAccount["groupPolicy"];
  };
  type ResolvedPolicy = ConfigInput & { groupPolicy: NonNullable<PolicyAccount["groupPolicy"]> };
  it.each([
    [
      "allowlist",
      createAllowlistProviderGroupPolicyWarningCollector,
      ({ channelLabel, groupPolicy }: ResolvedPolicy) =>
        groupPolicy === "open" ? [`warn:${channelLabel}`] : [],
      ["warn:example"],
    ],
    [
      "open",
      createOpenProviderGroupPolicyWarningCollector,
      ({ groupPolicy }: ResolvedPolicy) => [groupPolicy],
      ["open"],
    ],
  ] as const)("builds config-aware %s-provider collectors", (_name, create, collect, expected) => {
    const collectWarnings = create<ConfigInput>({
      providerConfigPresent: accountPolicy.providerConfigPresent,
      resolveGroupPolicy: ({ configuredGroupPolicy }) => configuredGroupPolicy,
      collect,
    });
    expect(
      collectWarnings({
        cfg: exampleConfig,
        channelLabel: "example",
        configuredGroupPolicy: "open",
      }),
    ).toEqual(expected);
  });

  it("builds account-aware route-allowlist collectors", () => {
    const collectWarnings = createAllowlistProviderRouteAllowlistWarningCollector<
      PolicyAccount & {
        groups?: Record<string, unknown>;
      }
    >({
      ...accountPolicy,
      resolveRouteAllowlistConfigured: (account) => Object.keys(account.groups ?? {}).length > 0,
      ...routeWarnings,
    });

    expect(collectWarnings(withAccount({ groupPolicy: "open", groups: {} }))).toEqual([
      '- Example groups: groupPolicy="open" with no channels.example.groups allowlist; any group can add + ping (mention-gated). Set channels.example.groupPolicy="allowlist" + channels.example.groupAllowFrom or configure channels.example.groups.',
    ]);
  });

  it("builds account-aware configured-route collectors", () => {
    const collectWarnings = createOpenProviderConfiguredRouteWarningCollector<
      PolicyAccount & {
        channels?: Record<string, unknown>;
      }
    >({
      ...accountPolicy,
      resolveRouteAllowlistConfigured: (account) => Object.keys(account.channels ?? {}).length > 0,
      configureRouteAllowlist,
      missingRouteAllowlist,
    });

    expect(
      collectWarnings(withAccount({ groupPolicy: "open", channels: { general: true } })),
    ).toEqual([buildOpenGroupPolicyConfigureRouteAllowlistWarning(configureRouteAllowlist)]);
  });

  it("builds account-aware simple open warning collectors", () => {
    const collectWarnings = createAllowlistProviderOpenWarningCollector<PolicyAccount>({
      ...accountPolicy,
      buildOpenWarning: openWarning,
    });

    expect(collectWarnings(withAccount({ groupPolicy: "open" }))).toEqual([
      buildOpenGroupPolicyWarning(openWarning),
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
