import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const { resolveDiscordChannelAllowlistMock, resolveDiscordUserAllowlistMock } = vi.hoisted(() => ({
  resolveDiscordChannelAllowlistMock: vi.fn(
    async (_params: { entries: string[] }) => [] as Array<Record<string, unknown>>,
  ),
  resolveDiscordUserAllowlistMock: vi.fn(async (params: { entries: string[] }) =>
    params.entries.map((entry) => {
      switch (entry) {
        case "Alice":
          return { input: entry, resolved: true, id: "111" };
        case "Bob":
          return { input: entry, resolved: true, id: "222" };
        case "Carol":
          return { input: entry, resolved: false };
        case "387":
          return { input: entry, resolved: true, id: "387", name: "Peter" };
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

  it("logs discord name metadata for resolved and unresolved allowlist entries", async () => {
    resolveDiscordChannelAllowlistMock.mockResolvedValueOnce([
      {
        input: "145/c404",
        resolved: false,
        guildId: "145",
        guildName: "Ops",
        channelName: "missing-room",
      },
    ]);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;

    await resolveDiscordAllowlistConfig({
      token: "token",
      allowFrom: ["387"],
      guildEntries: {
        "145": {
          channels: {
            c404: {},
          },
        },
      },
      fetcher: vi.fn() as unknown as typeof fetch,
      runtime,
    });

    const logs = (runtime.log as ReturnType<typeof vi.fn>).mock.calls
      .map(([line]) => String(line))
      .join("\n");
    expect(logs).toContain(
      "discord channels unresolved: 145/c404 (guild:Ops; channel:missing-room)",
    );
    expect(logs).toContain("discord users resolved: 387→Peter (id:387)");
  });
});
