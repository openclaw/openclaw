import { describe, expect, it, vi } from "vitest";
import { resolveDiscordAllowFromEntries } from "./discord.js";

describe("resolveDiscordAllowFromEntries", () => {
  it("keeps direct user ids when token is present and no username lookup is needed", async () => {
    const resolveUsers = vi.fn(async () => []);
    const result = await resolveDiscordAllowFromEntries({
      token: "token",
      entries: ["994979735488692324", "<@123456789012345678>", "discord:777"],
      resolveUsers,
    });

    expect(result.lookupFailed).toBe(false);
    expect(result.unresolved).toEqual([]);
    expect(result.ids).toEqual(["994979735488692324", "123456789012345678", "777"]);
    expect(resolveUsers).not.toHaveBeenCalled();
  });

  it("resolves usernames and preserves direct ids in the same input list", async () => {
    const resolveUsers = vi.fn(async () => [
      {
        input: "@alice",
        resolved: true,
        id: "111111111111111111",
      },
    ]);
    const result = await resolveDiscordAllowFromEntries({
      token: "token",
      entries: ["@alice", "222222222222222222"],
      resolveUsers,
    });

    expect(result.lookupFailed).toBe(false);
    expect(result.unresolved).toEqual([]);
    expect(result.ids).toEqual(["222222222222222222", "111111111111111111"]);
    expect(resolveUsers).toHaveBeenCalledTimes(1);
  });

  it("reports unresolved usernames when token is missing", async () => {
    const resolveUsers = vi.fn(async () => []);
    const result = await resolveDiscordAllowFromEntries({
      entries: ["@alice", "333333333333333333"],
      resolveUsers,
    });

    expect(result.lookupFailed).toBe(false);
    expect(result.unresolved).toEqual(["@alice"]);
    expect(result.ids).toEqual(["333333333333333333"]);
    expect(resolveUsers).not.toHaveBeenCalled();
  });
});
