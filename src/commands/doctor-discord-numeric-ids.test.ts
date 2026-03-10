import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  maybeRepairDiscordNumericIds,
  scanDiscordNumericIdEntries,
} from "./doctor-discord-numeric-ids.js";

describe("doctor discord numeric ids", () => {
  it("scans numeric entries across top-level and account-scoped discord lists", () => {
    const hits = scanDiscordNumericIdEntries({
      channels: {
        discord: {
          allowFrom: ["already-string", 123],
          dm: { allowFrom: [456], groupChannels: ["789", 999] },
          execApprovals: { approvers: [321] },
          guilds: {
            "100": {
              users: [111],
              roles: ["222", 333],
              channels: {
                general: { users: [444], roles: ["555"] },
              },
            },
          },
          accounts: {
            work: {
              allowFrom: [666],
              dm: { allowFrom: ["777"], groupChannels: [888] },
            },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(hits).toEqual([
      { path: "channels.discord.allowFrom[1]", entry: 123 },
      { path: "channels.discord.dm.allowFrom[0]", entry: 456 },
      { path: "channels.discord.dm.groupChannels[1]", entry: 999 },
      { path: "channels.discord.execApprovals.approvers[0]", entry: 321 },
      { path: "channels.discord.guilds.100.users[0]", entry: 111 },
      { path: "channels.discord.guilds.100.roles[1]", entry: 333 },
      { path: "channels.discord.guilds.100.channels.general.users[0]", entry: 444 },
      { path: "channels.discord.accounts.work.allowFrom[0]", entry: 666 },
      { path: "channels.discord.accounts.work.dm.groupChannels[0]", entry: 888 },
    ]);
  });

  it("converts numeric ids to strings while preserving untouched entries", () => {
    const original = {
      channels: {
        discord: {
          allowFrom: [123, "already-string"],
          dm: { allowFrom: [456], groupChannels: ["789", 999] },
          execApprovals: { approvers: [321] },
          guilds: {
            "100": {
              users: [111],
              roles: ["222", 333],
              channels: {
                general: { users: [444], roles: ["555"] },
              },
            },
          },
          accounts: {
            work: {
              allowFrom: [666],
              dm: { allowFrom: ["777"], groupChannels: [888] },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairDiscordNumericIds(original);

    expect(result.changes).toEqual([
      "- channels.discord.allowFrom: converted 1 numeric entry to strings",
      "- channels.discord.dm.allowFrom: converted 1 numeric entry to strings",
      "- channels.discord.dm.groupChannels: converted 1 numeric entry to strings",
      "- channels.discord.execApprovals.approvers: converted 1 numeric entry to strings",
      "- channels.discord.guilds.100.users: converted 1 numeric entry to strings",
      "- channels.discord.guilds.100.roles: converted 1 numeric entry to strings",
      "- channels.discord.guilds.100.channels.general.users: converted 1 numeric entry to strings",
      "- channels.discord.accounts.work.allowFrom: converted 1 numeric entry to strings",
      "- channels.discord.accounts.work.dm.groupChannels: converted 1 numeric entry to strings",
    ]);
    expect(result.config).toEqual({
      channels: {
        discord: {
          allowFrom: ["123", "already-string"],
          dm: { allowFrom: ["456"], groupChannels: ["789", "999"] },
          execApprovals: { approvers: ["321"] },
          guilds: {
            "100": {
              users: ["111"],
              roles: ["222", "333"],
              channels: {
                general: { users: ["444"], roles: ["555"] },
              },
            },
          },
          accounts: {
            work: {
              allowFrom: ["666"],
              dm: { allowFrom: ["777"], groupChannels: ["888"] },
            },
          },
        },
      },
    });
    expect(original.channels?.discord?.allowFrom).toEqual([123, "already-string"]);
  });

  it("returns the original config unchanged when no numeric ids are present", () => {
    const cfg = {
      channels: {
        discord: {
          allowFrom: ["123"],
          dm: { allowFrom: ["456"], groupChannels: ["789"] },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairDiscordNumericIds(cfg);

    expect(result).toEqual({ config: cfg, changes: [] });
  });
});
