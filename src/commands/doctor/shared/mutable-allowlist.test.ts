import { describe, expect, it } from "vitest";
import {
  collectMutableAllowlistWarnings,
  scanMutableAllowlistEntries,
} from "./mutable-allowlist.js";

describe("doctor mutable allowlist scanner", () => {
  it("finds mutable built-in allowlist entries when dangerous matching is disabled", () => {
    const hits = scanMutableAllowlistEntries({
      channels: {
        irc: {
          allowFrom: ["charlie"],
          groups: {
            "#ops": {
              allowFrom: ["dana"],
            },
          },
        },
        googlechat: {
          groupAllowFrom: ["engineering@example.com"],
        },
      },
    });

    expect(hits).toEqual(
      expect.arrayContaining([
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
          channel: "googlechat",
          path: "channels.googlechat.groupAllowFrom",
          entry: "engineering@example.com",
        }),
      ]),
    );
  });

  it("skips scopes that explicitly allow dangerous name matching", () => {
    const hits = scanMutableAllowlistEntries({
      channels: {
        googlechat: {
          dangerouslyAllowNameMatching: true,
          groupAllowFrom: ["engineering@example.com"],
        },
      },
    });

    expect(hits).toEqual([]);
  });

  it("formats mutable allowlist warnings", () => {
    const warnings = collectMutableAllowlistWarnings([
      {
        channel: "irc",
        path: "channels.irc.allowFrom",
        entry: "bob",
        dangerousFlagPath: "channels.irc.dangerouslyAllowNameMatching",
      },
      {
        channel: "googlechat",
        path: "channels.googlechat.groupAllowFrom",
        entry: "engineering@example.com",
        dangerousFlagPath: "channels.googlechat.dangerouslyAllowNameMatching",
      },
    ]);

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mutable allowlist entries across googlechat, irc"),
        expect.stringContaining("channels.irc.allowFrom: bob"),
        expect.stringContaining("channels.googlechat.groupAllowFrom: engineering@example.com"),
        expect.stringContaining("Option A"),
        expect.stringContaining("Option B"),
      ]),
    );
  });
});
