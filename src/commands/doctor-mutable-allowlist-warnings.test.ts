import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { scanMutableAllowlistEntries } from "./doctor-mutable-allowlist-warnings.js";

describe("doctor mutable allowlist warnings", () => {
  it("skips account hits when dangerous name matching is inherited from the provider", () => {
    const hits = scanMutableAllowlistEntries({
      channels: {
        slack: {
          dangerouslyAllowNameMatching: true,
          accounts: {
            work: {
              allowFrom: ["alice"],
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([]);
  });

  it("reports mutable slack entries when an account disables inherited name matching", () => {
    const hits = scanMutableAllowlistEntries({
      channels: {
        slack: {
          dangerouslyAllowNameMatching: true,
          accounts: {
            work: {
              dangerouslyAllowNameMatching: false,
              allowFrom: ["alice", "U01234567"],
              dm: {
                allowFrom: [" bob ", "<@U76543210>"],
              },
              channels: {
                general: {
                  users: ["charlie", "UABCDEF12"],
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([
      {
        channel: "slack",
        path: "channels.slack.accounts.work.allowFrom",
        entry: "alice",
        dangerousFlagPath: "channels.slack.accounts.work.dangerouslyAllowNameMatching",
      },
      {
        channel: "slack",
        path: "channels.slack.accounts.work.dm.allowFrom",
        entry: "bob",
        dangerousFlagPath: "channels.slack.accounts.work.dangerouslyAllowNameMatching",
      },
      {
        channel: "slack",
        path: "channels.slack.accounts.work.channels.general.users",
        entry: "charlie",
        dangerousFlagPath: "channels.slack.accounts.work.dangerouslyAllowNameMatching",
      },
    ]);
  });

  it("scans provider and nested paths across supported mutable allowlist channels", () => {
    const hits = scanMutableAllowlistEntries({
      channels: {
        googlechat: {
          accounts: {
            work: {
              groupAllowFrom: ["user@example.com"],
              dm: {
                allowFrom: ["users/direct@example.com"],
              },
              groups: {
                team: {
                  users: ["room@example.com"],
                },
              },
            },
          },
        },
        irc: {
          allowFrom: ["alice"],
          groupAllowFrom: ["bob"],
          groups: {
            dev: {
              allowFrom: ["carol"],
            },
          },
        },
        mattermost: {
          groupAllowFrom: ["dora"],
        },
        msteams: {
          allowFrom: ["erin@example.com"],
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([
      {
        channel: "googlechat",
        path: "channels.googlechat.accounts.work.groupAllowFrom",
        entry: "user@example.com",
        dangerousFlagPath: "channels.googlechat.dangerouslyAllowNameMatching",
      },
      {
        channel: "googlechat",
        path: "channels.googlechat.accounts.work.dm.allowFrom",
        entry: "users/direct@example.com",
        dangerousFlagPath: "channels.googlechat.dangerouslyAllowNameMatching",
      },
      {
        channel: "googlechat",
        path: "channels.googlechat.accounts.work.groups.team.users",
        entry: "room@example.com",
        dangerousFlagPath: "channels.googlechat.dangerouslyAllowNameMatching",
      },
      {
        channel: "msteams",
        path: "channels.msteams.allowFrom",
        entry: "erin@example.com",
        dangerousFlagPath: "channels.msteams.dangerouslyAllowNameMatching",
      },
      {
        channel: "mattermost",
        path: "channels.mattermost.groupAllowFrom",
        entry: "dora",
        dangerousFlagPath: "channels.mattermost.dangerouslyAllowNameMatching",
      },
      {
        channel: "irc",
        path: "channels.irc.allowFrom",
        entry: "alice",
        dangerousFlagPath: "channels.irc.dangerouslyAllowNameMatching",
      },
      {
        channel: "irc",
        path: "channels.irc.groupAllowFrom",
        entry: "bob",
        dangerousFlagPath: "channels.irc.dangerouslyAllowNameMatching",
      },
      {
        channel: "irc",
        path: "channels.irc.groups.dev.allowFrom",
        entry: "carol",
        dangerousFlagPath: "channels.irc.dangerouslyAllowNameMatching",
      },
    ]);
  });
});
