import { describe, expect, it } from "vitest";
import { maybeRepairOpenPolicyAllowFrom } from "./open-policy-allowfrom.js";

describe("doctor open-policy allowFrom repair", () => {
  it('adds top-level wildcard when dmPolicy="open" has no allowFrom', () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        signal: {
          dmPolicy: "open",
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.signal.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.signal?.allowFrom).toEqual(["*"]);
  });

  it("repairs nested-only googlechat dm allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        googlechat: {
          dm: {
            policy: "open",
          },
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.googlechat.dm.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.googlechat?.dm?.allowFrom).toEqual(["*"]);
  });

  it("appends wildcard to discord nested dm allowFrom when top-level is absent", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        discord: {
          dm: {
            policy: "open",
            allowFrom: ["123"],
          },
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.discord.dm.allowFrom: added "*" (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.discord?.dm?.allowFrom).toEqual(["123", "*"]);
  });
});
