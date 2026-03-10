import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { maybeRepairOpenPolicyAllowFrom } from "./doctor-open-policy-allowfrom.js";

describe("doctor open policy allowFrom", () => {
  it("sets top-level allowFrom for top-only channels", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        telegram: {
          dmPolicy: "open",
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.changes).toEqual([
      '- channels.telegram.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config).toEqual({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
  });

  it("prefers existing nested dm.allowFrom for top-or-nested channels", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        discord: {
          dmPolicy: "open",
          dm: {
            allowFrom: ["123"],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.changes).toEqual([
      '- channels.discord.dm.allowFrom: added "*" (required by dmPolicy="open")',
    ]);
    expect(result.config).toEqual({
      channels: {
        discord: {
          dmPolicy: "open",
          dm: {
            allowFrom: ["123", "*"],
          },
        },
      },
    });
  });

  it("repairs googlechat nested allowFrom even when a stale top-level wildcard exists", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        googlechat: {
          allowFrom: ["*"],
          dm: {
            policy: "open",
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.changes).toEqual([
      '- channels.googlechat.dm.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config).toEqual({
      channels: {
        googlechat: {
          allowFrom: ["*"],
          dm: {
            policy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
  });

  it("repairs per-account open dmPolicy without touching accounts that already include a wildcard", () => {
    const original = {
      channels: {
        slack: {
          accounts: {
            work: {
              dmPolicy: "open",
              allowFrom: ["U123"],
            },
            ready: {
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairOpenPolicyAllowFrom(original);

    expect(result.changes).toEqual([
      '- channels.slack.accounts.work.allowFrom: added "*" (required by dmPolicy="open")',
    ]);
    expect(result.config).toEqual({
      channels: {
        slack: {
          accounts: {
            work: {
              dmPolicy: "open",
              allowFrom: ["U123", "*"],
            },
            ready: {
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        },
      },
    });
    expect(original.channels?.slack?.accounts?.work?.allowFrom).toEqual(["U123"]);
  });

  it("returns the original config when no repair is needed", () => {
    const cfg = {
      channels: {
        discord: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairOpenPolicyAllowFrom(cfg);

    expect(result).toEqual({ config: cfg, changes: [] });
  });
});
