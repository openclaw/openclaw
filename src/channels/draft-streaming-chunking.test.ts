import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChannelDraftStreamingChunking } from "./draft-streaming-chunking.js";

describe("resolveChannelDraftStreamingChunking", () => {
  it.each([
    { channelId: "discord", cfg: {}, accountId: undefined, fallbackLimit: 2000 },
    { channelId: "telegram", cfg: undefined, accountId: "default", fallbackLimit: 4096 },
  ] as const)(
    "returns draft stream defaults when $channelId chunking is unset",
    ({ channelId, cfg, accountId, fallbackLimit }) => {
      expect(
        resolveChannelDraftStreamingChunking(cfg, channelId, accountId, { fallbackLimit }),
      ).toEqual({
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
      });
    },
  );

  it("clamps requested draft chunk sizes to the resolved text limit", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          textChunkLimit: 500,
          streaming: {
            preview: {
              chunk: {
                minChars: 900,
                maxChars: 1200,
                breakPreference: "sentence",
              },
            },
          },
        },
      },
    };

    expect(
      resolveChannelDraftStreamingChunking(cfg, "discord", undefined, {
        fallbackLimit: 2000,
      }),
    ).toEqual({
      minChars: 500,
      maxChars: 500,
      breakPreference: "sentence",
    });
  });

  it("prefers account draft chunking over channel defaults", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          allowFrom: ["*"],
          streaming: {
            preview: {
              chunk: {
                minChars: 200,
                maxChars: 800,
                breakPreference: "paragraph",
              },
            },
          },
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
    };

    expect(
      resolveChannelDraftStreamingChunking(cfg, "telegram", "default", {
        fallbackLimit: 4096,
      }),
    ).toEqual({
      minChars: 10,
      maxChars: 20,
      breakPreference: "newline",
    });
  });
});
