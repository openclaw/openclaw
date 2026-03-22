import { describe, expect, it } from "vitest";
import {
  resolveChannelAccountConfigValue,
  resolveChannelConfigValue,
} from "../../ui/src/ui/views/channel-config-extras.ts";

describe("channel config value resolution", () => {
  it("prefers account-scoped channel config when accountId is provided", () => {
    const config = {
      channels: {
        discord: {
          enabled: true,
          accounts: {
            "discord-main": {
              token: "account-token",
              dmPolicy: "allow",
            },
          },
        },
      },
    } satisfies Record<string, unknown>;

    expect(resolveChannelAccountConfigValue(config, "discord", "discord-main")).toEqual({
      token: "account-token",
      dmPolicy: "allow",
    });
    expect(resolveChannelConfigValue(config, "discord", "discord-main")).toEqual({
      token: "account-token",
      dmPolicy: "allow",
    });
  });

  it("falls back to channel root config when the requested account is missing", () => {
    const config = {
      channels: {
        discord: {
          enabled: true,
          dmPolicy: "mentions",
          accounts: {
            default: {
              token: "default-token",
            },
          },
        },
      },
    } satisfies Record<string, unknown>;

    expect(resolveChannelAccountConfigValue(config, "discord", "discord-main")).toBeNull();
    expect(resolveChannelConfigValue(config, "discord", "discord-main")).toEqual({
      enabled: true,
      dmPolicy: "mentions",
      accounts: {
        default: {
          token: "default-token",
        },
      },
    });
  });
});
