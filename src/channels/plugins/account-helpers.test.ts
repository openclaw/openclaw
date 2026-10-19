import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import {
  createAccountListHelpers,
  describeAccountSnapshot,
  describeWebhookAccountSnapshot,
  resolveListedDefaultAccountId,
} from "./account-helpers.js";

const { resolveDefaultAccountId } = createAccountListHelpers("testchannel");

function cfg(
  accounts: Record<string, unknown>,
  defaultAccount?: string,
  root: Record<string, unknown> = {},
): OpenClawConfig {
  return {
    channels: { testchannel: { ...root, accounts, ...(defaultAccount ? { defaultAccount } : {}) } },
  } as unknown as OpenClawConfig;
}

afterEach(() => vi.unstubAllEnvs());

describe("createAccountListHelpers", () => {
  it("keeps an implicit default account when root env credentials coexist with named accounts", () => {
    vi.stubEnv("TESTCHANNEL_TOKEN", "env-token");
    const helpers = createAccountListHelpers("testchannel", {
      implicitDefaultAccount: { envVars: ["TESTCHANNEL_TOKEN"] },
    });
    expect(helpers.listAccountIds(cfg({ work: {} }))).toEqual(["default", "work"]);
  });

  it("does not synthesize an account when an owner disables the empty fallback", () => {
    const helpers = createAccountListHelpers("testchannel", {
      fallbackAccountIdWhenEmpty: false,
      implicitDefaultAccount: { channelKeys: ["token"] },
    });

    expect(helpers.listAccountIds({} as OpenClawConfig)).toEqual([]);
    expect(helpers.listAccountIds(cfg({}))).toEqual([]);
    expect(
      helpers.listAccountIds({
        channels: { testchannel: { token: "root-token" } },
      } as unknown as OpenClawConfig),
    ).toEqual(["default"]);
    expect(helpers.resolveDefaultAccountId({} as OpenClawConfig)).toBe("default");
  });

  it("combines additional owner-discovered accounts without changing stable order", () => {
    const helpers = createAccountListHelpers("testchannel", {
      additionalAccountIds: () => ["bound", "work", "bound"],
    });

    expect(helpers.listAccountIds(cfg({ work: {}, alerts: {} }))).toEqual([
      "alerts",
      "bound",
      "work",
    ]);
  });

  it("allows a single-account owner to name its configured implicit account", () => {
    const helpers = createAccountListHelpers("testchannel", {
      fallbackAccountIdWhenEmpty: false,
      resolveImplicitAccountId: (config) => {
        const channel = config.channels?.["testchannel"] as
          | { token?: string; defaultAccount?: string }
          | undefined;
        return channel?.token ? (channel.defaultAccount ?? "default") : undefined;
      },
    });

    expect(helpers.listAccountIds({} as OpenClawConfig)).toEqual([]);
    expect(
      helpers.listAccountIds({
        channels: { testchannel: { token: "root-token", defaultAccount: "work" } },
      } as unknown as OpenClawConfig),
    ).toEqual(["work"]);
  });
  it('returns "default" for empty config', () => {
    expect(resolveDefaultAccountId({})).toBe("default");
  });
});

describe("createAccountListHelpers account resolution", () => {
  type TestAccountConfig = {
    enabled?: boolean;
    defaultAccount?: string;
    name?: string;
    token?: string | { source: "env"; provider: string; id: string };
    commands?: { native?: boolean; callbackPath?: string };
    accounts?: Record<string, Partial<TestAccountConfig>>;
  };

  const resolver = createAccountListHelpers<TestAccountConfig>("testchannel", {
    normalizeAccountId,
    omitKeys: ["defaultAccount"],
    nestedObjectKeys: ["commands"],
    implicitDefaultAccount: { channelKeys: ["token"] },
  });

  it("shares normalized account enumeration and configured default selection", () => {
    const input = cfg({ "Work Team": { name: "Work" }, alerts: {} }, "Work Team");

    expect(resolver.listConfiguredAccountIds(input)).toEqual(["work-team", "alerts"]);
    expect(resolver.listAccountIds(input)).toEqual(["alerts", "work-team"]);
    expect(resolver.resolveDefaultAccountId(input)).toBe("work-team");
  });

  it("merges owner-declared nested fields while omitting account-selection metadata", () => {
    const input = cfg(
      {
        "Work Team": { enabled: true, name: "Work", commands: { callbackPath: "/work" } },
      },
      "Work Team",
      { enabled: false, commands: { native: true } },
    );

    expect(resolver.resolveAccountConfig(input, "work-team")).toEqual({
      enabled: true,
      name: "Work",
      commands: { native: true, callbackPath: "/work" },
    });
    expect(input.channels?.["testchannel"]).toMatchObject({ enabled: false });
  });

  it("preserves unresolved SecretRef values without inspecting credentials", () => {
    const token = { source: "env" as const, provider: "default", id: "TESTCHANNEL_TOKEN" };
    const input = cfg({ work: { token } });

    expect(resolver.resolveAccountConfig(input, "work").token).toBe(token);
  });
});

it("supports an explicit fallback id for ambiguous multi-account setups", () => {
  expect(
    resolveListedDefaultAccountId({
      accountIds: ["alerts", "work"],
      ambiguousFallbackAccountId: "default",
    }),
  ).toBe("default");
});
it("normalizes missing identity fields to the shared defaults", () => {
  expect(describeAccountSnapshot({ account: {} })).toEqual({
    accountId: "default",
    name: undefined,
    enabled: true,
    configured: undefined,
  });
});

it("defaults mode to webhook while preserving caller extras", () => {
  expect(
    describeWebhookAccountSnapshot({
      account: { accountId: "work", name: "Work" },
      configured: true,
      extra: { tokenSource: "config" },
    }),
  ).toEqual({
    accountId: "work",
    name: "Work",
    enabled: true,
    configured: true,
    tokenSource: "config",
    mode: "webhook",
  });
});
