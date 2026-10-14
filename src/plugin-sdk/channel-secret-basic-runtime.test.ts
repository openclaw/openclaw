import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it } from "vitest";
import { coerceConfig, resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import {
  collectConditionalChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  collectSecretInputAssignment,
  resolveChannelAccountSurface,
  type ResolverContext,
} from "./channel-secret-basic-runtime.js";

function createContext(): ResolverContext {
  return {
    sourceConfig: {},
    env: {},
    cache: {},
    warnings: [],
    warningKeys: new Set(),
    assignments: [],
  };
}

describe("channel secret assignments", () => {
  it("keeps providerless refs accepted by the public assignment collector", () => {
    const context = createContext();
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
      webhookSecret: { source: "env" as const, provider: "default", id: "FIXTURE_WEBHOOK" },
      accounts: {
        webhook: { mode: "webhook" },
        polling: { mode: "polling" },
        override: {
          mode: "webhook",
          webhookSecret: {
            source: "env" as const,
            provider: "default",
            id: "FIXTURE_OVERRIDE",
          },
        },
      },
    };
    const context = createContext();
    const surface = resolveChannelAccountSurface(channel);

    collectConditionalChannelFieldAssignments({
      channelKey: "example",
      field: "webhookSecret",
      channel,
      surface,
      defaults: undefined,
      context,
      topLevelActiveWithoutAccounts: true,
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled && account.mode === "webhook" && !Object.hasOwn(account, "webhookSecret"),
      accountActive: ({ account, enabled }) => enabled && account.mode === "webhook",
      topInactiveReason: "webhook mode inactive",
      accountInactiveReason: "account webhook mode inactive",
    });

    expect(context.assignments.map(({ path, ownerId }) => ({ path, ownerId }))).toEqual([
      { path: "channels.example.webhookSecret", ownerId: "example:webhook" },
      {
        path: "channels.example.accounts.override.webhookSecret",
        ownerId: "example:override",
      },
    ]);
  });

  it("binds every consumer of one inherited field to the same atomic contract", () => {
    const collect = (betaEndpoint: string, reverseAccounts = false) => {
      const accounts = {
        alpha: { endpoint: "https://alpha.example.invalid" },
        beta: { endpoint: betaEndpoint },
      };
      const channel = {
        token: { source: "env" as const, provider: "default", id: "FIXTURE_SHARED" },
        accounts: reverseAccounts
          ? { beta: accounts.beta, alpha: accounts.alpha }
          : { alpha: accounts.alpha, beta: accounts.beta },
      };
      const context = createContext();
      collectSimpleChannelFieldAssignments({
        channelKey: "example",
        field: "token",
        channel,
        surface: resolveChannelAccountSurface(channel),
        defaults: undefined,
        context,
        topInactiveReason: "inactive",
        accountInactiveReason: "inactive account",
      });
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
    const read = resolveConfigForRead(
      {
        channels: {
          discord: {
            accounts: {
              "0": { token: "${ACCOUNT_ZERO_TOKEN}" },
              "prod.guild": { token: "${ACCOUNT_DOTTED_TOKEN}" },
            },
          },
        },
      },
      {},
    );
    const sourceConfig = coerceConfig(read.resolvedConfigRaw);
    setConfigResolutionFacts(sourceConfig, read.resolutionFacts);
    const channel = asOptionalRecord(sourceConfig.channels?.discord);
    assert(channel);
    const context = { ...createContext(), sourceConfig };

    collectSimpleChannelFieldAssignments({
      channelKey: "discord",
      field: "token",
      channel,
      surface: resolveChannelAccountSurface(channel),
      defaults: undefined,
      context,
      topInactiveReason: "inactive",
      accountInactiveReason: "inactive account",
    });

    const refByPath = new Map(
      context.assignments.map((assignment) => [assignment.path, assignment.ref]),
    );
    expect([...refByPath.keys()].toSorted()).toEqual([
      'channels.discord.accounts["0"].token',
      'channels.discord.accounts["prod.guild"].token',
    ]);
    expect(refByPath.get('channels.discord.accounts["0"].token')).toEqual({
      source: "env",
      provider: "default",
      id: "ACCOUNT_ZERO_TOKEN",
    });
    expect(refByPath.get('channels.discord.accounts["prod.guild"].token')).toEqual({
      source: "env",
      provider: "default",
      id: "ACCOUNT_DOTTED_TOKEN",
    });
  });
});
