import { describe, expect, it } from "vitest";
import type { MessageActionRunResult } from "../infra/outbound/message-action-runner.js";
import { formatMessageCliText } from "./message-format.js";

describe("formatMessageCliText", () => {
  it("shows dry-run line for send results even when handledBy is core", () => {
    const result: MessageActionRunResult = {
      kind: "send",
      action: "send",
      channel: "slack",
      to: "channel:C123",
      handledBy: "core",
      payload: { messageId: "unknown" },
      dryRun: true,
    };

    expect(formatMessageCliText(result)).toEqual(["[dry-run] would run send via slack"]);
  });

  it("shows dry-run line for poll results even when handledBy is core", () => {
    const result: MessageActionRunResult = {
      kind: "poll",
      action: "poll",
      channel: "slack",
      to: "channel:C123",
      handledBy: "core",
      payload: { messageId: "unknown" },
      dryRun: true,
    };

    expect(formatMessageCliText(result)).toEqual(["[dry-run] would run poll via slack"]);
  });
});
