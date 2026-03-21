import { describe, expect, it } from "vitest";
import { maybeRepairDiscordNumericIds, scanDiscordNumericIdEntries } from "./discord.js";

describe("doctor discord provider repairs", () => {
  it("finds numeric id entries across discord scopes", () => {
    const hits = scanDiscordNumericIdEntries({
      channels: {
        discord: {
          allowFrom: [123],
          dm: { allowFrom: ["ok"], groupChannels: [456] },
          execApprovals: { approvers: [789] },
          guilds: {
            main: {
              users: [111],
              roles: [222],
              channels: {
                general: {
                  users: [333],
                  roles: [444],
                },
              },
            },
          },
        },
      },
    });

    expect(hits.map((hit) => hit.path)).toEqual([
      "channels.discord.allowFrom[0]",
      "channels.discord.dm.groupChannels[0]",
      "channels.discord.execApprovals.approvers[0]",
      "channels.discord.guilds.main.users[0]",
      "channels.discord.guilds.main.roles[0]",
      "channels.discord.guilds.main.channels.general.users[0]",
      "channels.discord.guilds.main.channels.general.roles[0]",
    ]);
  });

  it("repairs numeric discord ids into strings", () => {
    const result = maybeRepairDiscordNumericIds({
      channels: {
        discord: {
          allowFrom: [123],
          accounts: {
            work: {
              execApprovals: { approvers: [456] },
            },
          },
        },
      },
    });

    expect(result.changes).toEqual([
      expect.stringContaining("channels.discord.allowFrom: converted 1 numeric entry to strings"),
      expect.stringContaining(
        "channels.discord.accounts.work.execApprovals.approvers: converted 1 numeric entry to strings",
      ),
    ]);
    expect(result.config.channels?.discord?.allowFrom).toEqual(["123"]);
    expect(result.config.channels?.discord?.accounts?.work?.execApprovals?.approvers).toEqual([
      "456",
    ]);
  });
});
