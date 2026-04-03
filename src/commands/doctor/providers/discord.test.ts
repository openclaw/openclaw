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
              allowFrom: [234],
              dm: { allowFrom: [345], groupChannels: [456] },
              execApprovals: { approvers: [456] },
              guilds: {
                ops: {
                  users: [567],
                  roles: [678],
                  channels: {
                    alerts: {
                      users: [789],
                      roles: [890],
                    },
                  },
                },
              },
            },
          },
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

    const result = maybeRepairDiscordNumericIds(cfg);

    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("channels.discord.allowFrom: converted 1 numeric entry to strings"),
        expect.stringContaining(
          "channels.discord.accounts.work.allowFrom: converted 1 numeric entry to strings",
        ),
        expect.stringContaining(
          "channels.discord.accounts.work.dm.allowFrom: converted 1 numeric entry to strings",
        ),
        expect.stringContaining(
          "channels.discord.accounts.work.dm.groupChannels: converted 1 numeric entry to strings",
        ),
        expect.stringContaining(
          "channels.discord.accounts.work.execApprovals.approvers: converted 1 numeric entry to strings",
        ),
        expect.stringContaining(
          "channels.discord.accounts.work.guilds.ops.users: converted 1 numeric entry to strings",
        ),
        expect.stringContaining(
          "channels.discord.accounts.work.guilds.ops.roles: converted 1 numeric entry to strings",
        ),
        expect.stringContaining(
          "channels.discord.accounts.work.guilds.ops.channels.alerts.users: converted 1 numeric entry to strings",
        ),
        expect.stringContaining(
          "channels.discord.accounts.work.guilds.ops.channels.alerts.roles: converted 1 numeric entry to strings",
        ),
        expect.stringContaining(
          "channels.discord.guilds.main.users: converted 1 numeric entry to strings",
        ),
        expect.stringContaining(
          "channels.discord.guilds.main.roles: converted 1 numeric entry to strings",
        ),
        expect.stringContaining(
          "channels.discord.guilds.main.channels.general.users: converted 1 numeric entry to strings",
        ),
        expect.stringContaining(
          "channels.discord.guilds.main.channels.general.roles: converted 1 numeric entry to strings",
        ),
      ]),
    );
    expect(result.config.channels?.discord?.allowFrom).toEqual(["123"]);
    expect(result.config.channels?.discord?.guilds?.main?.users).toEqual(["111"]);
    expect(result.config.channels?.discord?.guilds?.main?.roles).toEqual(["222"]);
    expect(result.config.channels?.discord?.guilds?.main?.channels?.general?.users).toEqual([
      "333",
    ]);
    expect(result.config.channels?.discord?.guilds?.main?.channels?.general?.roles).toEqual([
      "444",
    ]);
    expect(result.config.channels?.discord?.accounts?.work?.allowFrom).toEqual(["234"]);
    expect(result.config.channels?.discord?.accounts?.work?.dm?.allowFrom).toEqual(["345"]);
    expect(result.config.channels?.discord?.accounts?.work?.dm?.groupChannels).toEqual(["456"]);
    expect(result.config.channels?.discord?.accounts?.work?.execApprovals?.approvers).toEqual([
      "456",
    ]);
    expect(result.config.channels?.discord?.accounts?.work?.guilds?.ops?.users).toEqual(["567"]);
    expect(result.config.channels?.discord?.accounts?.work?.guilds?.ops?.roles).toEqual(["678"]);
    expect(
      result.config.channels?.discord?.accounts?.work?.guilds?.ops?.channels?.alerts?.users,
    ).toEqual(["789"]);
    expect(
      result.config.channels?.discord?.accounts?.work?.guilds?.ops?.channels?.alerts?.roles,
    ).toEqual(["890"]);
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

  it("returns repair warnings when unsafe numeric ids block doctor fix", () => {
    const cfg = {
      channels: {
        discord: {
          allowFrom: [106232522769186816],
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairDiscordNumericIds(cfg, {
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("could not be auto-repaired"),
      expect.stringContaining('rerun "openclaw doctor --fix"'),
    ]);
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
      expect.stringContaining("manually quote the original values"),
    ]);
  });

  it("formats warnings for mixed safe and unsafe entries", () => {
    const warnings = collectDiscordNumericIdWarnings({
      hits: [
        { path: "channels.discord.allowFrom[0]", entry: 123, safe: true },
        { path: "channels.discord.dm.allowFrom[0]", entry: 456, safe: true },
        { path: "channels.discord.dm.allowFrom[1]", entry: 106232522769186816, safe: false },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("1 numeric entry");
    expect(warnings[1]).toContain('run "openclaw doctor --fix"');
    expect(warnings[2]).toContain("2 numeric entries in lists that cannot be auto-repaired");
    expect(warnings[2]).toContain("channels.discord.dm.allowFrom[0]");
    expect(warnings[3]).toContain('rerun "openclaw doctor --fix"');
  });
});
