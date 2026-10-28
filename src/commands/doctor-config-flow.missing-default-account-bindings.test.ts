import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramConfig } from "../config/types.telegram.js";
import {
  collectMissingDefaultAccountBindingWarnings,
  collectMissingExplicitDefaultAccountWarnings,
} from "./doctor/shared/default-account-warnings.js";

const accounts = { alerts: { botToken: "a" }, work: { botToken: "w" } };
function config(accountId?: string): OpenClawConfig {
  return {
    channels: { telegram: { accounts } },
    bindings: [{ agentId: "ops", match: { channel: "telegram", accountId } }],
  };
}

describe("missing default account warnings", () => {
  it.each([
    [undefined, "no valid account-scoped binding exists for configured accounts (alerts, work)"],
    ["alerts", "Uncovered accounts: work"],
  ])("identifies missing binding coverage with accountId=%s", (accountId, message) => {
    const warnings = collectMissingDefaultAccountBindingWarnings(config(accountId));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(message);
    expect(warnings[0]).toContain("bindings[].match.accountId");
  });

  it("accepts wildcard binding coverage", () => {
    expect(collectMissingDefaultAccountBindingWarnings(config("*"))).toEqual([]);
  });

  it("accepts complete explicit binding coverage", () => {
    const cfg = config("alerts");
    cfg.bindings?.push({ agentId: "ops", match: { channel: "telegram", accountId: "work" } });
    expect(collectMissingDefaultAccountBindingWarnings(cfg)).toEqual([]);
  });

  it.each<{ name: string; channel: TelegramConfig; message?: string }>([
    { name: "multiple accounts", channel: { accounts }, message: "no explicit default is set" },
    { name: "single account", channel: { accounts: { work: accounts.work } }, message: undefined },
    {
      name: "default account",
      channel: { accounts: { default: {}, ...accounts } },
      message: undefined,
    },
    {
      name: "normalized default",
      channel: { defaultAccount: "Router D", accounts: { "router-d": {}, work: {} } },
      message: undefined,
    },
    {
      name: "invalid default",
      channel: { defaultAccount: "missing", accounts },
      message:
        'defaultAccount is set to "missing" but does not match configured accounts (alerts, work)',
    },
  ])("checks explicit selection for $name", ({ channel, message }) => {
    const warnings = collectMissingExplicitDefaultAccountWarnings({
      channels: { telegram: channel },
    });
    if (message) {
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(message);
      expect(warnings[0]).toContain("channels.telegram.defaultAccount");
    } else {
      expect(warnings).toEqual([]);
    }
  });
});
