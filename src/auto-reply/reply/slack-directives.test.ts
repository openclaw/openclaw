import { describe, expect, it } from "vitest";
import { hasSlackDirectives, parseSlackDirectives } from "./slack-directives.js";

const getSlackInteractive = (result: ReturnType<typeof parseSlackDirectives>) =>
  result.interactive?.blocks ?? [];

describe("hasSlackDirectives", () => {
  it("matches expected detection across Slack directive patterns", () => {
    const cases: Array<{ text: string; expected: boolean }> = [
      { text: "Pick one [[slack_buttons: Approve:approve, Reject:reject]]", expected: true },
      {
        text: "[[slack_select: Choose a project | Alpha:alpha, Beta:beta]]",
        expected: true,
      },
      { text: "Just regular text", expected: false },
      { text: "[[buttons: Menu | Choose | A:a]]", expected: false },
    ];

    for (const testCase of cases) {
      expect(hasSlackDirectives(testCase.text)).toBe(testCase.expected);
    }
  });
});

describe("parseSlackDirectives", () => {
  it("builds shared text and button blocks from slack_buttons directives", () => {
    const result = parseSlackDirectives({
      text: "Choose an action [[slack_buttons: Approve:approve, Reject:reject]]",
    });

    expect(result.text).toBe("Choose an action");
    expect(getSlackInteractive(result)).toEqual([
      {
        type: "text",
        text: "Choose an action",
      },
      {
        type: "buttons",
        buttons: [
          {
            label: "Approve",
            value: "approve",
          },
          {
            label: "Reject",
            value: "reject",
          },
        ],
      },
    ]);
  });

  it("builds shared select blocks from slack_select directives", () => {
    const result = parseSlackDirectives({
      text: "[[slack_select: Choose a project | Alpha:alpha, Beta:beta]]",
    });

    expect(result.text).toBeUndefined();
    expect(getSlackInteractive(result)).toEqual([
      {
        type: "select",
        placeholder: "Choose a project",
        options: [
          { label: "Alpha", value: "alpha" },
          { label: "Beta", value: "beta" },
        ],
      },
    ]);
  });

  it("leaves existing slack blocks in channelData and appends shared interactive blocks", () => {
    const result = parseSlackDirectives({
      text: "Act now [[slack_buttons: Retry:retry]]",
      channelData: {
        slack: {
          blocks: [{ type: "divider" }],
        },
      },
    });

    expect(result.text).toBe("Act now");
    expect(result.channelData).toEqual({
      slack: {
        blocks: [{ type: "divider" }],
      },
    });
    expect(getSlackInteractive(result)).toEqual([
      {
        type: "text",
        text: "Act now",
      },
      {
        type: "buttons",
        buttons: [{ label: "Retry", value: "retry" }],
      },
    ]);
  });

  it("preserves authored order for mixed Slack directives", () => {
    const result = parseSlackDirectives({
      text: "[[slack_select: Pick one | Alpha:alpha]] then [[slack_buttons: Retry:retry]]",
    });

    expect(getSlackInteractive(result)).toEqual([
      {
        type: "select",
        placeholder: "Pick one",
        options: [{ label: "Alpha", value: "alpha" }],
      },
      {
        type: "text",
        text: "then",
      },
      {
        type: "buttons",
        buttons: [{ label: "Retry", value: "retry" }],
      },
    ]);
  });

  it("preserves long Slack directive values in the shared interactive model", () => {
    const long = "x".repeat(120);
    const result = parseSlackDirectives({
      text: `${"y".repeat(3100)} [[slack_select: ${long} | ${long}:${long}]] [[slack_buttons: ${long}:${long}]]`,
    });

    expect(getSlackInteractive(result)).toEqual([
      {
        type: "text",
        text: "y".repeat(3100),
      },
      {
        type: "select",
        placeholder: long,
        options: [{ label: long, value: long }],
      },
      {
        type: "buttons",
        buttons: [{ label: long, value: long }],
      },
    ]);
  });

  it("parses optional Slack button styles without truncating callback values", () => {
    const result = parseSlackDirectives({
      text: "[[slack_buttons: Approve:pluginbind:approval-123:o:primary, Reject:deny:danger, Skip:skip:secondary]]",
    });

    expect(getSlackInteractive(result)).toEqual([
      {
        type: "buttons",
        buttons: [
          {
            label: "Approve",
            value: "pluginbind:approval-123:o",
            style: "primary",
          },
          {
            label: "Reject",
            value: "deny",
            style: "danger",
          },
          {
            label: "Skip",
            value: "skip",
            style: "secondary",
          },
        ],
      },
    ]);
  });

  it("preserves slack_select values that end in style-like suffixes", () => {
    const result = parseSlackDirectives({
      text: "[[slack_select: Choose one | Queue:queue:danger, Archive:archive:primary]]",
    });

    expect(getSlackInteractive(result)).toEqual([
      {
        type: "select",
        placeholder: "Choose one",
        options: [
          {
            label: "Queue",
            value: "queue:danger",
          },
          {
            label: "Archive",
            value: "archive:primary",
          },
        ],
      },
    ]);
  });

  it("keeps existing interactive blocks when compiling additional Slack directives", () => {
    const result = parseSlackDirectives({
      text: "Choose [[slack_buttons: Retry:retry]]",
      interactive: {
        blocks: [{ type: "text", text: "Existing" }],
      },
    });

    expect(getSlackInteractive(result)).toEqual([
      { type: "text", text: "Existing" },
      { type: "text", text: "Choose" },
      { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
    ]);
  });

  it("ignores malformed directive choices when none remain", () => {
    const result = parseSlackDirectives({
      text: "Choose [[slack_buttons: : , : ]]",
    });

    expect(result).toEqual({
      text: "Choose [[slack_buttons: : , : ]]",
    });
  });
});
