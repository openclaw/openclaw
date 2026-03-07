import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { moveSingleAccountChannelSectionToDefaultAccount } from "./setup-helpers.js";

describe("moveSingleAccountChannelSectionToDefaultAccount", () => {
  it("moves whatsapp allowSendTo from root to accounts.default", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+111"],
          allowSendTo: ["+222"],
          dmPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const updated = moveSingleAccountChannelSectionToDefaultAccount({
      cfg,
      channelKey: "whatsapp",
    });

    const channel = (updated.channels as Record<string, unknown>).whatsapp as Record<
      string,
      unknown
    >;
    expect(channel.allowSendTo).toBeUndefined();

    const accounts = channel.accounts as Record<string, Record<string, unknown>>;
    expect(accounts[DEFAULT_ACCOUNT_ID]?.allowSendTo).toEqual(["+222"]);
    expect(accounts[DEFAULT_ACCOUNT_ID]?.allowFrom).toEqual(["+111"]);
  });

  it("does not rewrite when accounts already exist", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowSendTo: ["+222"],
          accounts: {
            default: { dmPolicy: "allowlist" },
          },
        },
      },
    } as OpenClawConfig;

    const updated = moveSingleAccountChannelSectionToDefaultAccount({
      cfg,
      channelKey: "whatsapp",
    });

    expect(updated).toEqual(cfg);
  });
});
