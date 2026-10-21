import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { coerceConfig, resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import { createResolverContext } from "../secrets/runtime-shared.js";
import {
  collectConditionalChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  collectSecretInputAssignment,
  resolveChannelAccountSurface,
} from "./channel-secret-basic-runtime.js";

function fieldParams(
  channel: Record<string, unknown>,
  context: ReturnType<typeof createResolverContext>,
  channelKey = "example",
) {
  return {
    channelKey,
    field: "token",
    channel,
    context,
    surface: resolveChannelAccountSurface(channel),
    defaults: undefined,
    topInactiveReason: "inactive",
    accountInactiveReason: "inactive account",
  };
}

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });

it("keeps providerless refs accepted by the public assignment collector", () => {
  const context = createResolverContext({ sourceConfig: {}, env: {} });
  collectSecretInputAssignment({
    value: { source: "env", id: "SYNTHETIC_CHANNEL_KEY" },
    path: "channels.example.token",
    expected: "string",
    defaults: { env: "channel-env" },
    context,
    apply: () => undefined,
  });
  expect(context.assignments.map(({ ref }) => ref)).toEqual([
    { source: "env", provider: "channel-env", id: "SYNTHETIC_CHANNEL_KEY" },
  ]);
});

it("keeps inherited webhook credentials owned only by webhook-mode accounts", () => {
  const channel = {
    webhookSecret: envRef("FIXTURE_WEBHOOK"),
    accounts: {
      webhook: { mode: "webhook" },
      polling: { mode: "polling" },
      override: {
        mode: "webhook",
        webhookSecret: envRef("FIXTURE_OVERRIDE"),
      },
    },
  };
  const context = createResolverContext({ sourceConfig: {}, env: {} });
  collectConditionalChannelFieldAssignments({
    ...fieldParams(channel, context),
    field: "webhookSecret",
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && account.mode === "webhook" && !Object.hasOwn(account, "webhookSecret"),
    accountActive: ({ account, enabled }) => enabled && account.mode === "webhook",
    topInactiveReason: "webhook mode inactive",
    accountInactiveReason: "account webhook mode inactive",
  });

  expect(context.assignments.map(({ path, ownerId }) => [path, ownerId])).toEqual([
    ["channels.example.webhookSecret", "example:webhook"],
    ["channels.example.accounts.override.webhookSecret", "example:override"],
  ]);
});

it("binds every consumer of one inherited field to the same atomic contract", () => {
  const collect = (betaEndpoint: string, reverseAccounts = false) => {
    const accounts = {
      alpha: { endpoint: "https://alpha.example.invalid" },
      beta: { endpoint: betaEndpoint },
    };
    const channel = {
      token: envRef("FIXTURE_SHARED"),
      accounts: reverseAccounts
        ? { beta: accounts.beta, alpha: accounts.alpha }
        : { alpha: accounts.alpha, beta: accounts.beta },
    };
    const context = createResolverContext({ sourceConfig: {}, env: {} });
    collectSimpleChannelFieldAssignments(fieldParams(channel, context));
    return context.assignments.map((assignment) => assignment.ownerContractDigest);
  };

  const initial = collect("https://beta.example.invalid");
  const changed = collect("https://changed.example.invalid");
  expect(initial).toHaveLength(2);
  expect(new Set(initial).size).toBe(1);
  expect(new Set(collect("https://beta.example.invalid", true))).toEqual(new Set(initial));
  expect(new Set(changed).size).toBe(1);
  expect(changed[0]).not.toBe(initial[0]);
});

it("finds authored env refs for account keys that need bracket quoting", () => {
  const accounts = {
    "0": { token: "${ACCOUNT_ZERO_TOKEN}" },
    "prod.guild": { token: "${ACCOUNT_DOTTED_TOKEN}" },
  };
  const read = resolveConfigForRead({ channels: { discord: { accounts } } }, {});
  const sourceConfig = coerceConfig(read.resolvedConfigRaw);
  setConfigResolutionFacts(sourceConfig, read.resolutionFacts);
  const channel = asOptionalRecord(sourceConfig.channels?.discord);
  assert(channel);
  const context = createResolverContext({ sourceConfig, env: {} });

  collectSimpleChannelFieldAssignments(fieldParams(channel, context, "discord"));

  expect(new Map(context.assignments.map(({ path, ref }) => [path, ref]))).toEqual(
    new Map([
      ['channels.discord.accounts["0"].token', envRef("ACCOUNT_ZERO_TOKEN")],
      ['channels.discord.accounts["prod.guild"].token', envRef("ACCOUNT_DOTTED_TOKEN")],
    ]),
  );
});
