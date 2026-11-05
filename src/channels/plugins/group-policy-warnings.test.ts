import { expect, it } from "vitest";
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

const warning = {
  surface: "Example groups",
  openScope: "any member",
  groupPolicyPath: "channels.example.groupPolicy",
  groupAllowFromPath: "channels.example.groupAllowFrom",
};
type Account = { groupPolicy?: "open" | "allowlist" | "disabled"; routes?: boolean };
const policy = {
  providerConfigPresent: (cfg: OpenClawConfig) => cfg.channels?.example !== undefined,
  resolveGroupPolicy: (account: Account) => account.groupPolicy,
};
const routePolicy = {
  ...policy,
  resolveRouteAllowlistConfigured: (account: Account) => account.routes ?? false,
};
const routeWarning = { ...warning, routeAllowlistPath: "channels.example.channels" };
const cfg = { channels: { example: {} } };
const input = {
  cfg: { channels: { slack: {} } },
  accountId: "acct-2",
  account: { accountId: "acct-1" },
};
type Input = typeof input;

it.each([
  [
    projectConfigAccountIdWarningCollector<Input>(({ accountId }) => [accountId ?? "default"]),
    ["acct-2"],
  ],
  [projectAccountWarningCollector<Input["account"], Input>((a) => [a.accountId]), ["acct-1"]],
  [
    projectAccountConfigWarningCollector<Input["account"], Record<string, unknown>, Input>(
      (config) => config.channels ?? {},
      ({ account, cfg: channels }) => [account.accountId, channels.slack ? "slack" : "none"],
    ),
    ["acct-1", "slack"],
  ],
] as const)("projects warning collector %# inputs", (collect, result) => {
  expect(collect(input)).toEqual(result);
});

it("composes account-scoped warnings and omits absent results", () => {
  const collect = composeAccountWarningCollectors<
    { enabled: boolean },
    { account: { enabled: boolean } }
  >(
    () => ["base"],
    (a) => (a.enabled ? "enabled" : undefined),
    () => ["a", "b"],
  );
  expect(collect({ account: { enabled: true } })).toEqual(["base", "enabled", "a", "b"]);
  expect(collect({ account: { enabled: false } })).toEqual(["base", "a", "b"]);
});

it.each([false, true])("resolves runtime policy with provider=%s", (present) => {
  expect(
    collectAllowlistProviderRestrictSendersWarnings({
      ...warning,
      cfg: { channels: { defaults: { groupPolicy: "open" } } },
      providerConfigPresent: present,
      configuredGroupPolicy: present ? "open" : undefined,
    }),
  ).toStrictEqual(present ? [buildOpenGroupPolicyRestrictSendersWarning(warning)] : []);
});

const restrict = createAllowlistProviderRestrictSendersWarningCollector({ ...policy, ...warning });
const routes = createAllowlistProviderRouteAllowlistWarningCollector({
  ...routePolicy,
  restrictSenders: warning,
  noRouteAllowlist: {
    ...warning,
    routeAllowlistPath: "channels.example.groups",
    routeScope: "group",
  },
});
const configured = createOpenProviderConfiguredRouteWarningCollector({
  ...routePolicy,
  configureRouteAllowlist: routeWarning,
  missingRouteAllowlist: { surface: "", openBehavior: "", remediation: "" },
});
it.each([
  ["restrict senders", restrict, false, buildOpenGroupPolicyRestrictSendersWarning(warning)],
  ["configured routes", routes, true, buildOpenGroupPolicyRestrictSendersWarning(warning)],
  [
    "missing routes",
    routes,
    false,
    '- Example groups: groupPolicy="open" with no channels.example.groups allowlist; any group can add + ping (mention-gated). Set channels.example.groupPolicy="allowlist" + channels.example.groupAllowFrom or configure channels.example.groups.',
  ],
  [
    "open provider",
    configured,
    true,
    buildOpenGroupPolicyConfigureRouteAllowlistWarning(routeWarning),
  ],
] as const)("collects %s warnings", (_name, collect, hasRoutes, result) => {
  expect(collect({ cfg, account: { groupPolicy: "open", routes: hasRoutes } })).toEqual([result]);
});

it("collects direct open-policy warnings without mention gating", () => {
  const options = {
    ...policy,
    ...warning,
    defaultGroupPolicy: "allowlist" as const,
    mentionGated: false,
  };
  const collect = createOpenGroupPolicyRestrictSendersWarningCollector(options);
  expect(collect({ groupPolicy: "allowlist" })).toStrictEqual([]);
  expect(collect({ groupPolicy: "open" })).toEqual([
    buildOpenGroupPolicyRestrictSendersWarning(options),
  ]);
});
