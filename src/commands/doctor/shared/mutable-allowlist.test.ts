import { describe, expect, it } from "vitest";
import { scanMutableAllowlistEntries } from "./mutable-allowlist.js";

describe("doctor mutable allowlist scanner", () => {
  it("finds mutable discord, irc, and zalouser entries when dangerous matching is disabled", () => {
    const hits = scanMutableAllowlistEntries({
      channels: {
        discord: {
          allowFrom: ["alice"],
          guilds: {
            ops: {
              users: ["bob"],
              roles: [],
              channels: {},
            },
          },
        },
        irc: {
          allowFrom: ["charlie"],
          groups: {
            "#ops": {
              allowFrom: ["dana"],
            },
          },
        },
        zalouser: {
          groups: {
            "Ops Room": { allow: true },
          },
        },
      },
    });

    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "discord",
          path: "channels.discord.allowFrom",
          entry: "alice",
        }),
        expect.objectContaining({
          channel: "discord",
          path: "channels.discord.guilds.ops.users",
          entry: "bob",
        }),
        expect.objectContaining({
          channel: "irc",
          path: "channels.irc.allowFrom",
          entry: "charlie",
        }),
        expect.objectContaining({
          channel: "irc",
          path: "channels.irc.groups.#ops.allowFrom",
          entry: "dana",
        }),
        expect.objectContaining({
          channel: "zalouser",
          path: "channels.zalouser.groups",
          entry: "Ops Room",
        }),
      ]),
    );
  });

  it("skips scopes that explicitly allow dangerous name matching", () => {
    const hits = scanMutableAllowlistEntries({
      channels: {
        slack: {
          dangerouslyAllowNameMatching: true,
          allowFrom: ["alice"],
        },
      },
    });

    expect(hits).toEqual([]);
  });
});
