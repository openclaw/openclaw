import { describe, expect, it } from "vitest";
import {
  collectInteractiveCommandFallbacks,
  hasReplyChannelData,
  hasReplyContent,
  hasReplyPayloadContent,
  normalizeInteractiveReply,
  renderInteractiveCommandFallback,
  resolveInteractiveActionId,
  resolveInteractiveTextFallback,
} from "./payload.js";

describe("hasReplyChannelData", () => {
  it.each([
    { value: undefined, expected: false },
    { value: {}, expected: false },
    { value: [], expected: false },
    { value: { slack: { blocks: [] } }, expected: true },
  ] as const)("accepts non-empty objects only: %j", ({ value, expected }) => {
    expect(hasReplyChannelData(value)).toBe(expected);
  });
});

describe("hasReplyContent", () => {
  it("treats whitespace-only text and empty structured payloads as empty", () => {
    expect(
      hasReplyContent({
        text: "   ",
        mediaUrls: ["", "   "],
        interactive: { blocks: [] },
        hasChannelData: false,
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "shared interactive blocks",
      input: {
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
        },
      },
    },
    {
      name: "explicit extra content",
      input: {
        text: "   ",
        extraContent: true,
      },
    },
  ] as const)("accepts $name", ({ input }) => {
    expect(hasReplyContent(input)).toBe(true);
  });
});

describe("hasReplyPayloadContent", () => {
  it("trims text and falls back to channel data by default", () => {
    expect(
      hasReplyPayloadContent({
        text: "   ",
        channelData: { slack: { blocks: [] } },
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "explicit channel-data overrides",
      payload: {
        text: "   ",
        channelData: {},
      },
      options: {
        hasChannelData: true,
      },
    },
    {
      name: "extra content",
      payload: {
        text: "   ",
      },
      options: {
        extraContent: true,
      },
    },
  ] as const)("accepts $name", ({ payload, options }) => {
    expect(hasReplyPayloadContent(payload, options)).toBe(true);
  });
});

describe("interactive payload helpers", () => {
  it("normalizes interactive replies and resolves text fallbacks", () => {
    const interactive = normalizeInteractiveReply({
      fallbackText: "Use one of the commands below if buttons are unavailable.",
      blocks: [
        { type: "text", text: "First" },
        {
          type: "buttons",
          buttons: [
            {
              label: "Retry",
              value: "retry",
              actionId: "job.retry",
              fallbackCommand: "/job retry",
              fallbackText: "Retry the job",
            },
          ],
        },
        { type: "text", text: "Second" },
      ],
    });

    expect(interactive).toEqual({
      fallbackText: "Use one of the commands below if buttons are unavailable.",
      blocks: [
        { type: "text", text: "First" },
        {
          type: "buttons",
          buttons: [
            {
              label: "Retry",
              value: "retry",
              actionId: "job.retry",
              fallback: {
                command: "/job retry",
                text: "Retry the job",
              },
            },
          ],
        },
        { type: "text", text: "Second" },
      ],
    });
    expect(resolveInteractiveTextFallback({ interactive })).toBe("First\n\nSecond");
    const retryButton = interactive?.blocks[1];
    expect(retryButton?.type).toBe("buttons");
    if (retryButton?.type !== "buttons") {
      throw new Error("expected buttons block");
    }
    expect(resolveInteractiveActionId(retryButton.buttons[0])).toBe("job.retry");
    expect(collectInteractiveCommandFallbacks(interactive)).toEqual([
      {
        actionId: "job.retry",
        label: "Retry",
        command: "/job retry",
        text: "Retry the job",
      },
    ]);
    expect(renderInteractiveCommandFallback(interactive)).toBe("Retry: Retry the job (/job retry)");
  });

  it("uses fallback text and commands when there is no explicit text block", () => {
    const interactive = normalizeInteractiveReply({
      fallbackText: "Choose one of these commands:",
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Approve",
              value: "approve",
              fallbackCommand: "/approve yes",
            },
          ],
        },
      ],
    });

    expect(resolveInteractiveTextFallback({ interactive })).toBe("Choose one of these commands:");
    expect(renderInteractiveCommandFallback(interactive)).toBe("Approve: /approve yes");
  });
});
