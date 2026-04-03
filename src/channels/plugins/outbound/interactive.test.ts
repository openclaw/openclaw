import { describe, expect, it } from "vitest";
import { projectInteractiveReplyForCapabilities, reduceInteractiveReply } from "./interactive.js";

describe("reduceInteractiveReply", () => {
  it("walks authored blocks in order", () => {
    const order = reduceInteractiveReply(
      {
        blocks: [
          { type: "text", text: "first" },
          { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
          { type: "select", options: [{ label: "Alpha", value: "alpha" }] },
        ],
      },
      [] as string[],
      (state, block) => {
        state.push(block.type);
        return state;
      },
    );

    expect(order).toEqual(["text", "buttons", "select"]);
  });

  it("returns the initial state when interactive payload is missing", () => {
    expect(reduceInteractiveReply(undefined, 3, (value) => value + 1)).toBe(3);
  });
});

describe("projectInteractiveReplyForCapabilities", () => {
  it("converts selects into buttons when buttons are supported but selects are not", () => {
    expect(
      projectInteractiveReplyForCapabilities({
        interactive: {
          blocks: [
            {
              type: "select",
              placeholder: "Pick one",
              options: [{ label: "Alpha", value: "alpha", actionId: "choice.alpha" }],
            },
          ],
        },
        capabilities: {
          richReplies: {
            buttons: true,
            selects: false,
            commandFallback: true,
          },
        },
      }),
    ).toEqual({
      interactive: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Alpha", value: "alpha", actionId: "choice.alpha" }],
          },
        ],
      },
      fallbackText: undefined,
      degraded: true,
      mode: "widgets",
    });
  });

  it("appends fallback guidance when a text-only channel cannot render controls", () => {
    expect(
      projectInteractiveReplyForCapabilities({
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Retry",
                  value: "retry",
                  actionId: "job.retry",
                  fallback: { command: "/job retry", text: "Retry the job" },
                },
              ],
            },
          ],
          fallbackText: "Use a fallback action.",
        },
        capabilities: {
          richReplies: {
            buttons: false,
            selects: false,
            commandFallback: true,
          },
        },
      }),
    ).toEqual({
      interactive: {
        blocks: [
          {
            type: "text",
            text: "Use a fallback action.\n\nRetry: Retry the job (/job retry)",
          },
        ],
        fallbackText: "Use a fallback action.\n\nRetry: Retry the job (/job retry)",
      },
      fallbackText: "Use a fallback action.\n\nRetry: Retry the job (/job retry)",
      degraded: true,
      mode: "text",
    });
  });

  it("keeps the authored interactive payload intact for card-capable channels", () => {
    const interactive = {
      blocks: [
        { type: "text" as const, text: "Choose" },
        {
          type: "buttons" as const,
          buttons: [{ label: "Approve", value: "approve", actionId: "approval.approve" }],
        },
      ],
      fallbackText: "Use /approve if buttons are unavailable.",
    };

    expect(
      projectInteractiveReplyForCapabilities({
        interactive,
        capabilities: {
          richReplies: {
            cards: true,
            commandFallback: true,
          },
        },
      }),
    ).toEqual({
      interactive,
      fallbackText: "Use /approve if buttons are unavailable.",
      degraded: false,
      mode: "cards",
    });
  });
});
