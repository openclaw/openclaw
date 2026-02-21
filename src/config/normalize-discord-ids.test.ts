import { describe, expect, it } from "vitest";
import { normalizeDiscordIdListsInResolved } from "./normalize-discord-ids.js";

describe("normalizeDiscordIdListsInResolved", () => {
  it("returns input unchanged when no discord channel", () => {
    const input = { channels: { telegram: {} } };
    expect(normalizeDiscordIdListsInResolved(input)).toEqual(input);
  });

  it("converts numeric Discord ID list entries to strings", () => {
    const input = {
      channels: {
        discord: {
          allowFrom: [123, 456],
          execApprovals: { approvers: [321] },
          accounts: {
            work: {
              allowFrom: [888],
              execApprovals: { approvers: [999] },
            },
          },
        },
      },
    };
    const out = normalizeDiscordIdListsInResolved(input) as typeof input;
    expect(out.channels.discord.allowFrom).toEqual(["123", "456"]);
    expect(out.channels.discord.execApprovals.approvers).toEqual(["321"]);
    expect(out.channels.discord.accounts.work.allowFrom).toEqual(["888"]);
    expect(out.channels.discord.accounts.work.execApprovals.approvers).toEqual(["999"]);
  });

  it("leaves string entries as-is and does not mutate original", () => {
    const input = {
      channels: {
        discord: {
          allowFrom: ["1234567890123456789"],
          execApprovals: { approvers: ["9876543210987654321"] },
        },
      },
    };
    const out = normalizeDiscordIdListsInResolved(input) as typeof input;
    expect(out.channels.discord.allowFrom).toEqual(["1234567890123456789"]);
    expect(out.channels.discord.execApprovals.approvers).toEqual(["9876543210987654321"]);
    expect(input.channels.discord.allowFrom).toEqual(["1234567890123456789"]);
  });
});
