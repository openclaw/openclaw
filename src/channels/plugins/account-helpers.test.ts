import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import {
  createAccountListHelpers,
  describeAccountSnapshot,
  describeWebhookAccountSnapshot,
  resolveListedDefaultAccountId,
} from "./account-helpers.js";

function cfg(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { testchannel: section } } as unknown as OpenClawConfig;
}
afterEach(() => vi.unstubAllEnvs());

it("keeps an implicit default when env credentials coexist with named accounts", () => {
  vi.stubEnv("TESTCHANNEL_TOKEN", "env-token");
  const helpers = createAccountListHelpers("testchannel", {
    implicitDefaultAccount: { envVars: ["TESTCHANNEL_TOKEN"] },
  });
  expect(helpers.listAccountIds(cfg({ accounts: { work: {} } }))).toEqual(["default", "work"]);
});

it("does not synthesize accounts with the empty fallback disabled", () => {
  const helpers = createAccountListHelpers("testchannel", {
    fallbackAccountIdWhenEmpty: false,
    implicitDefaultAccount: { channelKeys: ["token"] },
  });
  expect(helpers.listAccountIds({})).toEqual([]);
  expect(helpers.listAccountIds(cfg({ accounts: {} }))).toEqual([]);
  expect(helpers.listAccountIds(cfg({ token: "root-token" }))).toEqual(["default"]);
  expect(helpers.resolveDefaultAccountId({})).toBe("default");
});

it("lets a single-account owner name its implicit account", () => {
  const helpers = createAccountListHelpers("testchannel", {
    fallbackAccountIdWhenEmpty: false,
    resolveImplicitAccountId: (config) => {
      const channel = config.channels?.testchannel as
        | { token?: string; defaultAccount?: string }
        | undefined;
      return channel?.token ? (channel.defaultAccount ?? "default") : undefined;
    },
  });
  expect(helpers.listAccountIds({})).toEqual([]);
  expect(helpers.listAccountIds(cfg({ token: "root-token", defaultAccount: "work" }))).toEqual([
    "work",
  ]);
});

type Account = {
  enabled?: boolean;
  name?: string;
  token?: string | { source: "env"; provider: string; id: string };
  commands?: { native?: boolean; callbackPath?: string };
};
const resolver = createAccountListHelpers<Account>("testchannel", {
  normalizeAccountId,
  omitKeys: ["defaultAccount"],
  nestedObjectKeys: ["commands"],
  implicitDefaultAccount: { channelKeys: ["token"] },
});

it("normalizes account enumeration and configured default selection", () => {
  const input = cfg({
    accounts: { "Work Team": { name: "Work" }, alerts: {} },
    defaultAccount: "Work Team",
  });
  expect(resolver.listConfiguredAccountIds(input)).toEqual(["work-team", "alerts"]);
  expect(resolver.listAccountIds(input)).toEqual(["alerts", "work-team"]);
  expect(resolver.resolveDefaultAccountId(input)).toBe("work-team");
});

it("merges nested fields without selection metadata or input mutation", () => {
  const input = cfg({
    accounts: { "Work Team": { enabled: true, name: "Work", commands: { callbackPath: "/work" } } },
    defaultAccount: "Work Team",
    enabled: false,
    commands: { native: true },
  });
  expect(resolver.resolveAccountConfig(input, "work-team")).toEqual({
    enabled: true,
    name: "Work",
    commands: { native: true, callbackPath: "/work" },
  });
  expect(input.channels?.testchannel).toMatchObject({ enabled: false });
});

it("preserves unresolved SecretRef identity without inspecting credentials", () => {
  const token = { source: "env" as const, provider: "default", id: "TESTCHANNEL_TOKEN" };
  expect(resolver.resolveAccountConfig(cfg({ accounts: { work: { token } } }), "work").token).toBe(
    token,
  );
});

it("supports an explicit fallback for ambiguous multi-account setups", () => {
  expect(
    resolveListedDefaultAccountId({
      accountIds: ["alerts", "work"],
      ambiguousFallbackAccountId: "default",
    }),
  ).toBe("default");
});

it("describes missing account fields with shared defaults", () => {
  expect(describeAccountSnapshot({ account: {} })).toEqual({
    accountId: "default",
    name: undefined,
    enabled: true,
    configured: undefined,
  });
});

it("describes webhook mode and caller extras", () => {
  const snapshot = describeWebhookAccountSnapshot({
    account: { accountId: "work", name: "Work" },
    configured: true,
    extra: { tokenSource: "config" },
  });
  expect([snapshot.accountId, snapshot.name, snapshot.enabled, snapshot.configured]).toEqual([
    "work",
    "Work",
    true,
    true,
  ]);
  expect([snapshot.mode, snapshot.tokenSource]).toEqual(["webhook", "config"]);
});
