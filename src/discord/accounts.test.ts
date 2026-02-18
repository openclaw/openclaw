import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { listDiscordAccountIds } from "./accounts.js";

function cfg(discord?: Record<string, unknown>): OpenClawConfig {
  return { channels: { discord: discord ?? {} } } as unknown as OpenClawConfig;
}

describe("listDiscordAccountIds", () => {
  it('returns ["default"] when no accounts and no token', () => {
    expect(listDiscordAccountIds(cfg())).toEqual(["default"]);
  });

  it('returns ["default"] when no accounts but top-level token exists', () => {
    expect(listDiscordAccountIds(cfg({ token: "bot-token" }))).toEqual(["default"]);
  });

  it("injects default when sub-accounts exist and top-level token is present", () => {
    expect(
      listDiscordAccountIds(
        cfg({
          token: "top-level-token",
          accounts: { "bot-b": {}, "bot-c": {} },
        }),
      ),
    ).toEqual(["bot-b", "bot-c", "default"]);
  });

  it("does not inject default when sub-accounts exist but no top-level token", () => {
    expect(
      listDiscordAccountIds(
        cfg({
          accounts: { "bot-b": {}, "bot-c": {} },
        }),
      ),
    ).toEqual(["bot-b", "bot-c"]);
  });

  it("does not duplicate default when already explicitly listed", () => {
    expect(
      listDiscordAccountIds(
        cfg({
          token: "top-level-token",
          accounts: { default: {}, "bot-b": {} },
        }),
      ),
    ).toEqual(["bot-b", "default"]);
  });

  it("returns sorted results", () => {
    expect(
      listDiscordAccountIds(
        cfg({
          token: "top-level-token",
          accounts: { zebra: {}, alpha: {} },
        }),
      ),
    ).toEqual(["alpha", "default", "zebra"]);
  });
});
