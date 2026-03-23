import { describe, expect, it } from "vitest";
import {
  collectMissingDefaultAccountBindingWarnings,
  collectMissingExplicitDefaultAccountWarnings,
} from "./default-account-warnings.js";

describe("collectMissingDefaultAccountBindingWarnings", () => {
  it("returns empty when config has no channels", () => {
    expect(collectMissingDefaultAccountBindingWarnings({})).toEqual([]);
  });

  it("returns empty when channel has accounts.default", () => {
    const warnings = collectMissingDefaultAccountBindingWarnings({
      channels: {
        telegram: {
          accounts: {
            default: { enabled: true },
            work: { enabled: true },
          },
        },
      },
    });
    expect(warnings).toEqual([]);
  });

  it("returns empty when channel has no accounts object", () => {
    const warnings = collectMissingDefaultAccountBindingWarnings({
      channels: {
        telegram: { enabled: true },
      },
    });
    expect(warnings).toEqual([]);
  });

  it("returns empty when wildcard binding covers the channel", () => {
    const warnings = collectMissingDefaultAccountBindingWarnings({
      channels: {
        telegram: {
          accounts: {
            work: { enabled: true },
            personal: { enabled: true },
          },
        },
      },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "*" } }],
    });
    expect(warnings).toEqual([]);
  });

  it("returns empty when all accounts have matching bindings", () => {
    const warnings = collectMissingDefaultAccountBindingWarnings({
      channels: {
        telegram: {
          accounts: {
            work: { enabled: true },
            personal: { enabled: true },
          },
        },
      },
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "work" } },
        { agentId: "main", match: { channel: "telegram", accountId: "personal" } },
      ],
    });
    expect(warnings).toEqual([]);
  });

  it("warns about uncovered accounts when bindings cover only a subset", () => {
    const warnings = collectMissingDefaultAccountBindingWarnings({
      channels: {
        telegram: {
          accounts: {
            work: { enabled: true },
            personal: { enabled: true },
          },
        },
      },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "work" } }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("channels.telegram");
    expect(warnings[0]).toContain("Uncovered accounts: personal");
  });

  it("warns when no account-scoped bindings exist for the channel", () => {
    const warnings = collectMissingDefaultAccountBindingWarnings({
      channels: {
        telegram: {
          accounts: {
            work: { enabled: true },
            personal: { enabled: true },
          },
        },
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("channels.telegram");
    expect(warnings[0]).toContain("no valid account-scoped binding");
    expect(warnings[0]).toContain("work");
    expect(warnings[0]).toContain("personal");
  });

  it("handles multiple channels independently", () => {
    const warnings = collectMissingDefaultAccountBindingWarnings({
      channels: {
        telegram: {
          accounts: {
            work: { enabled: true },
          },
        },
        discord: {
          accounts: {
            bot1: { enabled: true },
            bot2: { enabled: true },
          },
        },
      },
      bindings: [{ agentId: "main", match: { channel: "discord", accountId: "*" } }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("channels.telegram");
  });

  it("ignores bindings for other channels", () => {
    const warnings = collectMissingDefaultAccountBindingWarnings({
      channels: {
        telegram: {
          accounts: {
            work: { enabled: true },
            personal: { enabled: true },
          },
        },
      },
      bindings: [{ agentId: "main", match: { channel: "discord", accountId: "work" } }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("channels.telegram");
  });
});

describe("collectMissingExplicitDefaultAccountWarnings", () => {
  it("returns empty when config has no channels", () => {
    expect(collectMissingExplicitDefaultAccountWarnings({})).toEqual([]);
  });

  it("skips channels with only one account", () => {
    const warnings = collectMissingExplicitDefaultAccountWarnings({
      channels: {
        telegram: {
          accounts: {
            work: { enabled: true },
          },
        },
      },
    });
    expect(warnings).toEqual([]);
  });

  it("skips channels where defaultAccount matches a configured account", () => {
    const warnings = collectMissingExplicitDefaultAccountWarnings({
      channels: {
        telegram: {
          defaultAccount: "work",
          accounts: {
            work: { enabled: true },
            personal: { enabled: true },
          },
        },
      },
    });
    expect(warnings).toEqual([]);
  });

  it("warns when defaultAccount does not match any configured account", () => {
    const warnings = collectMissingExplicitDefaultAccountWarnings({
      channels: {
        telegram: {
          defaultAccount: "nonexistent",
          accounts: {
            work: { enabled: true },
            personal: { enabled: true },
          },
        },
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("channels.telegram");
    expect(warnings[0]).toContain("does not match configured accounts");
  });

  it("warns when multiple accounts exist but no defaultAccount is set", () => {
    const warnings = collectMissingExplicitDefaultAccountWarnings({
      channels: {
        telegram: {
          accounts: {
            work: { enabled: true },
            personal: { enabled: true },
          },
        },
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("channels.telegram");
    expect(warnings[0]).toContain("no explicit default is set");
  });

  it("handles multiple channels independently", () => {
    const warnings = collectMissingExplicitDefaultAccountWarnings({
      channels: {
        telegram: {
          defaultAccount: "work",
          accounts: {
            work: { enabled: true },
            personal: { enabled: true },
          },
        },
        discord: {
          accounts: {
            bot1: { enabled: true },
            bot2: { enabled: true },
          },
        },
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("channels.discord");
  });

  it("skips channels that have accounts.default", () => {
    const warnings = collectMissingExplicitDefaultAccountWarnings({
      channels: {
        telegram: {
          accounts: {
            default: { enabled: true },
            work: { enabled: true },
            personal: { enabled: true },
          },
        },
      },
    });
    expect(warnings).toEqual([]);
  });
});
