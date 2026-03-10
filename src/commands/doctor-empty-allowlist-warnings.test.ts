import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { detectEmptyAllowlistPolicy } from "./doctor-empty-allowlist-warnings.js";

describe("doctor empty allowlist warnings", () => {
  it("warns when dmPolicy allowlist has no sender entries", () => {
    const warnings = detectEmptyAllowlistPolicy({
      channels: {
        telegram: {
          dmPolicy: "allowlist",
        },
      },
    } as unknown as OpenClawConfig);

    expect(warnings).toEqual([
      '- channels.telegram.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to channels.telegram.allowFrom, or run "openclaw doctor --fix" to auto-migrate from pairing store when entries exist.',
    ]);
  });

  it("falls back from empty groupAllowFrom to allowFrom when the channel supports it", () => {
    const warnings = detectEmptyAllowlistPolicy({
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          allowFrom: ["12345"],
          groupAllowFrom: [],
        },
      },
    } as unknown as OpenClawConfig);

    expect(warnings).toEqual([]);
  });

  it("does not warn for googlechat sender-based group allowlists", () => {
    const warnings = detectEmptyAllowlistPolicy({
      channels: {
        googlechat: {
          groupPolicy: "allowlist",
          accounts: {
            work: {
              groupPolicy: "allowlist",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(warnings).toEqual([]);
  });

  it("warns when group allowlist does not fall back to allowFrom", () => {
    const warnings = detectEmptyAllowlistPolicy({
      channels: {
        imessage: {
          groupPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(warnings).toEqual([
      '- channels.imessage.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped. Add sender IDs to channels.imessage.groupAllowFrom, or set groupPolicy to "open".',
    ]);
  });

  it("inherits parent allowFrom and groupPolicy for account-scoped warnings", () => {
    const warnings = detectEmptyAllowlistPolicy({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          accounts: {
            work: {},
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(warnings).toEqual([
      '- channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.telegram.groupAllowFrom or channels.telegram.allowFrom, or set groupPolicy to "open".',
      '- channels.telegram.accounts.work.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.telegram.accounts.work.groupAllowFrom or channels.telegram.accounts.work.allowFrom, or set groupPolicy to "open".',
    ]);
  });
});
