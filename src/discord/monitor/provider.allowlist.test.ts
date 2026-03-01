import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const { resolveDiscordChannelAllowlistMock, resolveDiscordUserAllowlistMock } = vi.hoisted(() => ({
  resolveDiscordChannelAllowlistMock: vi.fn(async () => []),
  resolveDiscordUserAllowlistMock: vi.fn(async (params: { entries: string[] }) =>
    params.entries.map((entry) => {
      switch (entry) {
        case "Alice":
          return { input: entry, resolved: true, id: "111" };
        case "Bob":
          return { input: entry, resolved: true, id: "222" };
        case "Carol":
          return { input: entry, resolved: false };
        default:
          return { input: entry, resolved: true, id: entry };
      }
    }),
  ),
}));

vi.mock("../resolve-channels.js", () => ({
  resolveDiscordChannelAllowlist: resolveDiscordChannelAllowlistMock,
}));

vi.mock("../resolve-users.js", () => ({
  resolveDiscordUserAllowlist: resolveDiscordUserAllowlistMock,
}));

import { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";

describe("resolveDiscordAllowlistConfig", () => {
  it("canonicalizes resolved user names to ids in runtime config", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
    const result = await resolveDiscordAllowlistConfig({
      token: "token",
      allowFrom: ["Alice", "111", "*"],
      guildEntries: {
        "*": {
          users: ["Bob", "999"],
          channels: {
            "*": {
              users: ["Carol", "888"],
            },
          },
        },
      },
      fetcher: vi.fn() as unknown as typeof fetch,
      runtime,
    });

    expect(result.allowFrom).toEqual(["111", "*"]);
    expect(result.guildEntries?.["*"]?.users).toEqual(["222", "999"]);
    expect(result.guildEntries?.["*"]?.channels?.["*"]?.users).toEqual(["Carol", "888"]);
    expect(resolveDiscordUserAllowlistMock).toHaveBeenCalledTimes(2);
  });
});
