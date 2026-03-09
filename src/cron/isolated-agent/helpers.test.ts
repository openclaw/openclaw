import { describe, expect, it } from "vitest";
import {
  isHeartbeatOnlyResponse,
  pickFirstNonReasoningText,
  pickLastDeliverablePayload,
  pickLastNonEmptyTextFromPayloads,
  pickSummaryFromOutput,
  pickSummaryFromPayloads,
} from "./helpers.js";

describe("pickSummaryFromPayloads", () => {
  it("picks real text over error payload", () => {
    const payloads = [
      { text: "Here is your summary" },
      { text: "Tool error: rate limited", isError: true },
    ];
    expect(pickSummaryFromPayloads(payloads)).toBe("Here is your summary");
  });

  it("falls back to error payload when no real text exists", () => {
    const payloads = [{ text: "Tool error: rate limited", isError: true }];
    expect(pickSummaryFromPayloads(payloads)).toBe("Tool error: rate limited");
  });

  it("returns undefined for empty payloads", () => {
    expect(pickSummaryFromPayloads([])).toBeUndefined();
  });

  it("treats isError: undefined as non-error", () => {
    const payloads = [
      { text: "normal text", isError: undefined },
      { text: "error text", isError: true },
    ];
    expect(pickSummaryFromPayloads(payloads)).toBe("normal text");
  });
});

describe("pickLastNonEmptyTextFromPayloads", () => {
  it("picks real text over error payload", () => {
    const payloads = [{ text: "Real output" }, { text: "Service error", isError: true }];
    expect(pickLastNonEmptyTextFromPayloads(payloads)).toBe("Real output");
  });

  it("falls back to error payload when no real text exists", () => {
    const payloads = [{ text: "Service error", isError: true }];
    expect(pickLastNonEmptyTextFromPayloads(payloads)).toBe("Service error");
  });

  it("returns undefined for empty payloads", () => {
    expect(pickLastNonEmptyTextFromPayloads([])).toBeUndefined();
  });

  it("treats isError: undefined as non-error", () => {
    const payloads = [
      { text: "good", isError: undefined },
      { text: "bad", isError: true },
    ];
    expect(pickLastNonEmptyTextFromPayloads(payloads)).toBe("good");
  });
});

describe("pickLastDeliverablePayload", () => {
  it("picks real payload over error payload", () => {
    const real = { text: "Delivered content" };
    const error = { text: "Error warning", isError: true as const };
    expect(pickLastDeliverablePayload([real, error])).toBe(real);
  });

  it("falls back to error payload when no real payload exists", () => {
    const error = { text: "Error warning", isError: true as const };
    expect(pickLastDeliverablePayload([error])).toBe(error);
  });

  it("returns undefined for empty payloads", () => {
    expect(pickLastDeliverablePayload([])).toBeUndefined();
  });

  it("picks media payload over error text payload", () => {
    const media = { mediaUrl: "https://example.com/img.png" };
    const error = { text: "Error warning", isError: true as const };
    expect(pickLastDeliverablePayload([media, error])).toBe(media);
  });

  it("treats isError: undefined as non-error", () => {
    const normal = { text: "ok", isError: undefined };
    const error = { text: "bad", isError: true as const };
    expect(pickLastDeliverablePayload([normal, error])).toBe(normal);
  });
});

describe("pickSummaryFromOutput — thinking tag stripping (regression #40480)", () => {
  it("strips <think> tags from output text", () => {
    const text = "<think>I need to analyze the data...</think>\n\nHere is your daily report.";
    expect(pickSummaryFromOutput(text)).toBe("Here is your daily report.");
  });

  it("strips <thinking> tags", () => {
    const text =
      "<thinking>Step 1: gather data\nStep 2: format</thinking>Summary: all systems operational.";
    expect(pickSummaryFromOutput(text)).toBe("Summary: all systems operational.");
  });

  it("returns undefined when text is only thinking content", () => {
    expect(pickSummaryFromOutput("<think>internal only</think>")).toBeUndefined();
  });

  it("preserves text without thinking tags", () => {
    expect(pickSummaryFromOutput("All clear, no issues.")).toBe("All clear, no issues.");
  });

  it("strips <antthinking> tags", () => {
    const text = "<antthinking>Internal chain of thought</antthinking>Final answer.";
    expect(pickSummaryFromOutput(text)).toBe("Final answer.");
  });
});

describe("pickSummaryFromPayloads — isReasoning filtering (regression #40480)", () => {
  it("skips isReasoning payloads", () => {
    const payloads = [
      { text: "Internal reasoning about the task", isReasoning: true },
      { text: "Daily report: everything is fine." },
    ];
    expect(pickSummaryFromPayloads(payloads)).toBe("Daily report: everything is fine.");
  });

  it("never returns reasoning-only payloads", () => {
    expect(
      pickSummaryFromPayloads([{ text: "Thinking about it...", isReasoning: true }]),
    ).toBeUndefined();
  });

  it("falls back to error payload when only reasoning and error exist", () => {
    const payloads = [
      { text: "Some error", isError: true },
      { text: "Reasoning content", isReasoning: true },
    ];
    expect(pickSummaryFromPayloads(payloads)).toBe("Some error");
  });
});

describe("pickLastNonEmptyTextFromPayloads — isReasoning filtering (regression #40480)", () => {
  it("skips isReasoning payloads", () => {
    const payloads = [
      { text: "User-visible answer" },
      { text: "Internal reasoning", isReasoning: true },
    ];
    expect(pickLastNonEmptyTextFromPayloads(payloads)).toBe("User-visible answer");
  });
});

describe("pickLastDeliverablePayload — isReasoning filtering (regression #40480)", () => {
  it("skips isReasoning payloads", () => {
    const deliverable = { text: "Deliverable content" };
    const reasoning = { text: "Reasoning content", isReasoning: true as const };
    expect(pickLastDeliverablePayload([deliverable, reasoning])).toBe(deliverable);
  });
});

describe("pickFirstNonReasoningText", () => {
  it("picks first non-reasoning text", () => {
    const payloads = [
      { text: "Internal reasoning", isReasoning: true },
      { text: "User-facing text" },
    ];
    expect(pickFirstNonReasoningText(payloads)).toBe("User-facing text");
  });

  it("returns undefined when all payloads are reasoning", () => {
    expect(
      pickFirstNonReasoningText([{ text: "reasoning only", isReasoning: true }]),
    ).toBeUndefined();
  });

  it("skips empty text payloads", () => {
    const payloads = [{ text: "" }, { text: "actual content" }];
    expect(pickFirstNonReasoningText(payloads)).toBe("actual content");
  });

  it("returns undefined for empty payloads", () => {
    expect(pickFirstNonReasoningText([])).toBeUndefined();
  });
});

describe("isHeartbeatOnlyResponse", () => {
  const ACK_MAX = 300;

  it("returns true for empty payloads", () => {
    expect(isHeartbeatOnlyResponse([], ACK_MAX)).toBe(true);
  });

  it("returns true for a single HEARTBEAT_OK payload", () => {
    expect(isHeartbeatOnlyResponse([{ text: "HEARTBEAT_OK" }], ACK_MAX)).toBe(true);
  });

  it("returns false for a single non-heartbeat payload", () => {
    expect(isHeartbeatOnlyResponse([{ text: "Something important happened" }], ACK_MAX)).toBe(
      false,
    );
  });

  it("returns true when multiple payloads include narration followed by HEARTBEAT_OK", () => {
    // Agent narrates its work then signals nothing needs attention.
    expect(
      isHeartbeatOnlyResponse(
        [
          { text: "It's 12:49 AM — quiet hours. Let me run the checks quickly." },
          { text: "Emails: Just 2 calendar invites. Not urgent." },
          { text: "HEARTBEAT_OK" },
        ],
        ACK_MAX,
      ),
    ).toBe(true);
  });

  it("returns false when media is present even with HEARTBEAT_OK text", () => {
    expect(
      isHeartbeatOnlyResponse(
        [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" }],
        ACK_MAX,
      ),
    ).toBe(false);
  });

  it("returns false when media is in a different payload than HEARTBEAT_OK", () => {
    expect(
      isHeartbeatOnlyResponse(
        [
          { text: "HEARTBEAT_OK" },
          { text: "Here's an image", mediaUrl: "https://example.com/img.png" },
        ],
        ACK_MAX,
      ),
    ).toBe(false);
  });

  it("returns false when no payload contains HEARTBEAT_OK", () => {
    expect(
      isHeartbeatOnlyResponse(
        [{ text: "Checked emails — found 3 urgent messages from your manager." }],
        ACK_MAX,
      ),
    ).toBe(false);
  });
});
