import { describe, expect, it } from "vitest";
import { normalizeDmAliases } from "./doctor-legacy-dm-aliases.js";

describe("normalizeDmAliases", () => {
  it("moves legacy dm aliases to top-level keys and preserves unrelated dm config", () => {
    const result = normalizeDmAliases({
      entry: {
        dm: {
          enabled: true,
          policy: "open",
          allowFrom: ["*"],
        },
      },
      pathPrefix: "channels.slack",
    });

    expect(result.entry).toEqual({
      dm: { enabled: true },
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      "Moved channels.slack.dm.policy → channels.slack.dmPolicy.",
      "Moved channels.slack.dm.allowFrom → channels.slack.allowFrom.",
    ]);
  });

  it("removes duplicate legacy aliases when top-level values already exist", () => {
    const result = normalizeDmAliases({
      entry: {
        dmPolicy: "allowlist",
        allowFrom: ["123"],
        dm: {
          policy: "allowlist",
          allowFrom: ["123"],
        },
      },
      pathPrefix: "channels.discord.accounts.work",
    });

    expect(result.entry).toEqual({
      dmPolicy: "allowlist",
      allowFrom: ["123"],
    });
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      "Removed channels.discord.accounts.work.dm.policy (dmPolicy already set).",
      "Removed channels.discord.accounts.work.dm.allowFrom (allowFrom already set).",
      "Removed empty channels.discord.accounts.work.dm after migration.",
    ]);
  });

  it("keeps differing legacy aliases in dm when top-level values do not match", () => {
    const entry = {
      dmPolicy: "open",
      allowFrom: ["123"],
      dm: {
        policy: "allowlist",
        allowFrom: ["456"],
        groupEnabled: true,
      },
    };

    const result = normalizeDmAliases({
      entry,
      pathPrefix: "channels.discord",
    });

    expect(result.entry).toBe(entry);
    expect(result.changed).toBe(false);
    expect(result.changes).toEqual([]);
  });
});
