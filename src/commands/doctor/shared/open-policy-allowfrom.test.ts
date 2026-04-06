import { describe, expect, it } from "vitest";
import {
  collectOpenPolicyAllowFromWarnings,
  maybeRepairOpenPolicyAllowFrom,
} from "./open-policy-allowfrom.js";

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
      '- channels.googlechat.dmPolicy: set to "open" (migrated from channels.googlechat.dm.policy)',
      '- channels.googlechat.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(
      (result.config.channels?.googlechat as { allowFrom?: string[] } | undefined)?.allowFrom,
    ).toEqual(["*"]);
  });

  it("repairs nested-only matrix dm allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        matrix: {
          dm: {
            policy: "open",
          },
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.matrix.dmPolicy: set to "open" (migrated from channels.matrix.dm.policy)',
      '- channels.matrix.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.matrix?.allowFrom).toEqual(["*"]);
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
      '- channels.discord.dmPolicy: set to "open" (migrated from channels.discord.dm.policy)',
      '- channels.discord.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.discord?.allowFrom).toEqual(["*"]);
  });

  it("formats open-policy wildcard warnings", () => {
    const warnings = collectOpenPolicyAllowFromWarnings({
      changes: ['- channels.signal.allowFrom: set to ["*"] (required by dmPolicy="open")'],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining('channels.signal.allowFrom: set to ["*"]'),
      expect.stringContaining('Run "openclaw doctor --fix"'),
    ]);
  });
});
