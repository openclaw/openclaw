import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectMissingExplicitDefaultAccountWarnings } from "./doctor/shared/default-account-warnings.js";

function telegramConfig(accountIds: string[], defaultAccount?: string): OpenClawConfig {
  return {
    channels: {
      telegram: {
        accounts: Object.fromEntries(accountIds.map((id) => [id, { botToken: id }])),
        ...(defaultAccount === undefined ? {} : { defaultAccount }),
      },
    },
  };
}

describe("collectMissingExplicitDefaultAccountWarnings", () => {
  it("warns when multiple named accounts are configured without default selection", () => {
    expect(
      collectMissingExplicitDefaultAccountWarnings(telegramConfig(["alerts", "work"])),
    ).toEqual([
      "- channels.telegram: multiple accounts are configured but no explicit default is set. Set channels.telegram.defaultAccount or add channels.telegram.accounts.default to avoid fallback routing.",
    ]);
  });

  it("does not warn for a single named account without default", () => {
    expect(collectMissingExplicitDefaultAccountWarnings(telegramConfig(["work"]))).toStrictEqual(
      [],
    );
  });

  it("does not warn when accounts.default exists", () => {
    expect(
      collectMissingExplicitDefaultAccountWarnings(telegramConfig(["default", "work"])),
    ).toStrictEqual([]);
  });

  it("normalizes defaultAccount before validating configured account ids", () => {
    expect(
      collectMissingExplicitDefaultAccountWarnings(
        telegramConfig(["router-d", "work"], "Router D"),
      ),
    ).toStrictEqual([]);
  });

  it("warns when defaultAccount is invalid for configured accounts", () => {
    expect(
      collectMissingExplicitDefaultAccountWarnings(telegramConfig(["alerts", "work"], "missing")),
    ).toEqual([
      '- channels.telegram: defaultAccount is set to "missing" but does not match configured accounts (alerts, work). Set channels.telegram.defaultAccount to one of these accounts, or add channels.telegram.accounts.default to avoid fallback routing.',
    ]);
  });

  it("warns across channels that support account maps", () => {
    const cfg = telegramConfig(["alerts", "work"]);
    cfg.channels = {
      ...cfg.channels,
      slack: { accounts: { a: { botToken: "x" }, b: { botToken: "y" } } },
    };

    const warnings = collectMissingExplicitDefaultAccountWarnings(cfg);
    expect(warnings).toHaveLength(2);
    const warningOutput = warnings.join("\n");
    expect(warningOutput).toContain("channels.telegram");
    expect(warningOutput).toContain("channels.slack");
  });
});
