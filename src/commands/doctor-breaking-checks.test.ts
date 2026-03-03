import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import {
  collectBreakingChangeUpgradeWarnings,
  DOCTOR_BREAKING_CHANGE_CHECKS,
  noteBreakingChangeUpgradeWarnings,
} from "./doctor-breaking-checks.js";

describe("doctor breaking-change upgrade checks", () => {
  let prevTelegramToken: string | undefined;

  beforeEach(() => {
    prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    if (prevTelegramToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
    }
  });

  it("registers breaking-change checks with metadata", () => {
    expect(DOCTOR_BREAKING_CHANGE_CHECKS.length).toBeGreaterThan(0);
    expect(DOCTOR_BREAKING_CHANGE_CHECKS[0]).toMatchObject({
      id: expect.any(String),
      introducedIn: expect.any(String),
    });
  });

  it("warns for telegram allowlist mode without sender allowlist", () => {
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "token",
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const warnings = collectBreakingChangeUpgradeWarnings(cfg);
    const warningText = warnings.join("\n");
    expect(warningText).toContain("[2026.2.25]");
    expect(warningText).toContain('groupPolicy resolves to "allowlist"');
    expect(warningText).toContain("channels.telegram.groupAllowFrom");
  });

  it("warns for env-only telegram installs missing sender allowlist config", () => {
    process.env.TELEGRAM_BOT_TOKEN = "token";

    const warnings = collectBreakingChangeUpgradeWarnings({} as OpenClawConfig);
    const warningText = warnings.join("\n");
    expect(warningText).toContain('Telegram account "default"');
    expect(warningText).toContain("channels.telegram.groupAllowFrom");
  });

  it("uses account-scoped config path for named telegram accounts", () => {
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          accounts: {
            alerts: {
              botToken: "token",
              groupPolicy: "allowlist",
            },
          },
        },
      },
    } as OpenClawConfig;

    const warnings = collectBreakingChangeUpgradeWarnings(cfg);
    expect(warnings.join("\n")).toContain("channels.telegram.accounts.alerts.groupAllowFrom");
  });

  it("uses account-scoped config path for explicit default telegram account", () => {
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          accounts: {
            default: {
              botToken: "token",
              groupPolicy: "allowlist",
            },
          },
        },
      },
    } as OpenClawConfig;

    const warnings = collectBreakingChangeUpgradeWarnings(cfg);
    expect(warnings.join("\n")).toContain("channels.telegram.accounts.default.groupAllowFrom");
  });

  it("does not warn for configured telegram accounts without explicit groupPolicy", () => {
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "token",
        },
      },
    } as OpenClawConfig;

    expect(collectBreakingChangeUpgradeWarnings(cfg)).toEqual([]);
  });

  it("does not warn when telegram sender allowlist is configured", () => {
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "token",
          groupPolicy: "allowlist",
          groupAllowFrom: ["123456"],
        },
      },
    } as OpenClawConfig;

    expect(collectBreakingChangeUpgradeWarnings(cfg)).toEqual([]);
  });

  it("warns when groupAllowFrom is explicitly empty even if allowFrom has entries", () => {
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "token",
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          allowFrom: ["123456"],
        },
      },
    } as OpenClawConfig;

    expect(collectBreakingChangeUpgradeWarnings(cfg).join("\n")).toContain(
      'groupPolicy resolves to "allowlist"',
    );
  });

  it("warns when only some chats are opened via overrides", () => {
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "token",
          groupPolicy: "allowlist",
          groups: {
            "-100123": {
              groupPolicy: "open",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(collectBreakingChangeUpgradeWarnings(cfg).join("\n")).toContain(
      "no account-level sender allowlist is configured; only chats with explicit per-group/per-topic open or allowFrom overrides will work",
    );
  });

  it("warns when telegram allowlist entries are invalid usernames", () => {
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "token",
          groupPolicy: "allowlist",
          groupAllowFrom: ["@legacy-user"],
        },
      },
    } as OpenClawConfig;

    expect(collectBreakingChangeUpgradeWarnings(cfg).join("\n")).toContain(
      "no account-level sender allowlist is configured",
    );
  });

  it("does not warn when telegram sender allowlist uses normalized numeric ids", () => {
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "token",
          groupPolicy: "allowlist",
          groupAllowFrom: [" tg:123456789 "],
        },
      },
    } as OpenClawConfig;

    expect(collectBreakingChangeUpgradeWarnings(cfg)).toEqual([]);
  });

  it("emits upgrade notes only when warnings exist", () => {
    note.mockClear();
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "token",
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    noteBreakingChangeUpgradeWarnings(cfg);

    expect(note).toHaveBeenCalledTimes(1);
    expect(String(note.mock.calls[0]?.[1])).toBe("Upgrade");
    expect(String(note.mock.calls[0]?.[0])).toContain("openclaw doctor");

    note.mockClear();
    noteBreakingChangeUpgradeWarnings({} as OpenClawConfig);
    expect(note).not.toHaveBeenCalled();
  });
});
