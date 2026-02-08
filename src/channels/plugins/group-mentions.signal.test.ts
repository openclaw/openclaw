import { describe, expect, it } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import { resolveSignalGroupRequireMention } from "./group-mentions.js";

describe("resolveSignalGroupRequireMention", () => {
  it("returns false when group config sets requireMention to false", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          groups: {
            "test-group-123": {
              requireMention: false,
            },
          },
        },
      },
    };
    const result = resolveSignalGroupRequireMention({
      cfg,
      groupId: "test-group-123",
      accountId: "default",
    });
    expect(result).toBe(false);
  });

  it("returns true when group config sets requireMention to true", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          groups: {
            "test-group-123": {
              requireMention: true,
            },
          },
        },
      },
    };
    const result = resolveSignalGroupRequireMention({
      cfg,
      groupId: "test-group-123",
      accountId: "default",
    });
    expect(result).toBe(true);
  });

  it("returns wildcard config when specific group not found", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          groups: {
            "*": {
              requireMention: false,
            },
          },
        },
      },
    };
    const result = resolveSignalGroupRequireMention({
      cfg,
      groupId: "unknown-group",
      accountId: "default",
    });
    expect(result).toBe(false);
  });

  it("prefers specific group config over wildcard", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          groups: {
            "*": {
              requireMention: true,
            },
            "special-group": {
              requireMention: false,
            },
          },
        },
      },
    };
    const result = resolveSignalGroupRequireMention({
      cfg,
      groupId: "special-group",
      accountId: "default",
    });
    expect(result).toBe(false);
  });

  it("returns true by default when no group config exists", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {},
      },
    };
    const result = resolveSignalGroupRequireMention({
      cfg,
      groupId: "any-group",
      accountId: "default",
    });
    expect(result).toBe(true);
  });

  it("returns true when group config exists but requireMention is not set", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          groups: {
            "test-group": {},
          },
        },
      },
    };
    const result = resolveSignalGroupRequireMention({
      cfg,
      groupId: "test-group",
      accountId: "default",
    });
    expect(result).toBe(true);
  });

  it("supports account-specific groups config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            account1: {
              groups: {
                "group-123": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    };
    const result = resolveSignalGroupRequireMention({
      cfg,
      groupId: "group-123",
      accountId: "account1",
    });
    expect(result).toBe(false);
  });

  it("falls back to root groups when account-specific not found", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          groups: {
            "group-123": {
              requireMention: true,
            },
          },
          accounts: {
            account1: {},
          },
        },
      },
    };
    const result = resolveSignalGroupRequireMention({
      cfg,
      groupId: "group-123",
      accountId: "account1",
    });
    expect(result).toBe(true);
  });
});
