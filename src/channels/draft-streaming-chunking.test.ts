import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveChannelDraftStreamingChunking,
  type ChannelDraftStreamingChunking,
} from "./draft-streaming-chunking.js";

const defaults: ChannelDraftStreamingChunking = {
  minChars: 200,
  maxChars: 800,
  breakPreference: "paragraph",
};
const cases: Array<{
  name: string;
  channelId: "discord" | "telegram";
  cfg?: OpenClawConfig;
  accountId?: string;
  fallbackLimit: number;
  expected: ChannelDraftStreamingChunking;
}> = [
  {
    name: "empty channel defaults",
    channelId: "discord",
    cfg: {},
    fallbackLimit: 2000,
    expected: defaults,
  },
  {
    name: "absent config defaults",
    channelId: "telegram",
    accountId: "default",
    fallbackLimit: 4096,
    expected: defaults,
  },
  {
    name: "channel sizes clamped to text limit",
    channelId: "discord",
    fallbackLimit: 2000,
    cfg: {
      channels: {
        discord: {
          textChunkLimit: 500,
          streaming: {
            preview: { chunk: { minChars: 900, maxChars: 1200, breakPreference: "sentence" } },
          },
        },
      },
    },
    expected: { minChars: 500, maxChars: 500, breakPreference: "sentence" },
  },
  {
    name: "account overrides channel",
    channelId: "telegram",
    accountId: "default",
    fallbackLimit: 4096,
    cfg: {
      channels: {
        telegram: {
          allowFrom: ["*"],
          streaming: { preview: { chunk: { ...defaults } } },
          accounts: {
            default: {
              allowFrom: ["*"],
              streaming: {
                preview: {
                  chunk: {
                    minChars: 10,
                    maxChars: 20,
                    breakPreference: "newline",
                  },
                },
              },
            },
          },
        },
      },
    },
    expected: { minChars: 10, maxChars: 20, breakPreference: "newline" },
  },
];

it.each(cases)(
  "resolves draft chunking: $name",
  ({ cfg, channelId, accountId, fallbackLimit, expected }) => {
    expect(
      resolveChannelDraftStreamingChunking(cfg, channelId, accountId, { fallbackLimit }),
    ).toEqual(expected);
  },
);
