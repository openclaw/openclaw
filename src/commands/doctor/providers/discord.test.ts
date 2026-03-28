import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  collectDiscordNumericIdWarnings,
  maybeRepairDiscordNumericIds,
  scanDiscordNumericIdEntries,
} from "./discord.js";

describe("doctor discord provider repairs", () => {
  it("finds numeric id entries across discord scopes", () => {
    const cfg = {
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
    } as unknown as OpenClawConfig;

    const hits = scanDiscordNumericIdEntries(cfg);

    expect(hits.map((hit) => hit.path)).toEqual([
      "channels.discord.allowFrom[0]",
      "channels.discord.dm.groupChannels[0]",
      "channels.discord.execApprovals.approvers[0]",
      "channels.discord.guilds.main.users[0]",
      "channels.discord.guilds.main.roles[0]",
      "channels.discord.guilds.main.channels.general.users[0]",
      "channels.discord.guilds.main.channels.general.roles[0]",
    ]);
    expect(hits.every((hit) => hit.safe)).toBe(true);
  });

  it("marks unsafe numeric ids as not safe", () => {
    const cfg = {
      channels: {
        discord: {
          allowFrom: [106232522769186816, -1, 123.45, 42],
        },
      },
    } as unknown as OpenClawConfig;

    const hits = scanDiscordNumericIdEntries(cfg);

    expect(hits).toEqual([
      { path: "channels.discord.allowFrom[0]", entry: 106232522769186816, safe: false },
      { path: "channels.discord.allowFrom[1]", entry: -1, safe: false },
      { path: "channels.discord.allowFrom[2]", entry: 123.45, safe: false },
      { path: "channels.discord.allowFrom[3]", entry: 42, safe: true },
    ]);
  });

  it("repairs numeric discord ids into strings", () => {
    const cfg = {
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
    } as unknown as OpenClawConfig;

    const result = maybeRepairDiscordNumericIds(cfg);

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

  it("skips entire list when it contains unsafe numeric ids", () => {
    const cfg = {
      channels: {
        discord: {
          allowFrom: [42, 106232522769186816, -1, 123.45],
          dm: { allowFrom: [99] },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairDiscordNumericIds(cfg);

    expect(result.changes).toEqual([
      expect.stringContaining(
        "channels.discord.dm.allowFrom: converted 1 numeric entry to strings",
      ),
    ]);
    expect(result.config.channels?.discord?.allowFrom).toEqual([
      42, 106232522769186816, -1, 123.45,
    ]);
    expect(result.config.channels?.discord?.dm?.allowFrom).toEqual(["99"]);
  });

  it("formats numeric id warnings for safe entries", () => {
    const warnings = collectDiscordNumericIdWarnings({
      hits: [{ path: "channels.discord.allowFrom[0]", entry: 123, safe: true }],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining("Discord allowlists contain 1 numeric entry"),
      expect.stringContaining('run "openclaw doctor --fix"'),
    ]);
  });

  it("formats numeric id warnings for unsafe entries", () => {
    const warnings = collectDiscordNumericIdWarnings({
      hits: [{ path: "channels.discord.allowFrom[0]", entry: 106232522769186816, safe: false }],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining("cannot be auto-repaired"),
      expect.stringContaining("manually wrap the original value"),
    ]);
  });

  it("formats warnings for mixed safe and unsafe entries", () => {
    const warnings = collectDiscordNumericIdWarnings({
      hits: [
        { path: "channels.discord.allowFrom[0]", entry: 123, safe: true },
        { path: "channels.discord.allowFrom[1]", entry: 106232522769186816, safe: false },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("1 numeric entry");
    expect(warnings[1]).toContain('run "openclaw doctor --fix"');
    expect(warnings[2]).toContain("cannot be auto-repaired");
    expect(warnings[3]).toContain("manually wrap the original value");
  });
});
