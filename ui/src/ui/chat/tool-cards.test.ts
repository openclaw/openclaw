import { describe, expect, it } from "vitest";
import { extractToolCards } from "./tool-cards.ts";

describe("extractToolCards", () => {
  it("tags exec approval-pending tool results for empty-output status display", () => {
    const cards = extractToolCards({
      role: "toolResult",
      toolName: "exec",
      content: [],
      details: {
        status: "approval-pending",
        approvalId: "full-id",
        approvalSlug: "abcd1234",
        host: "gateway",
        command: "echo hi",
        cwd: "/",
      },
    });
    expect(cards.filter((c) => c.kind === "result")).toEqual([
      {
        kind: "result",
        name: "exec",
        text: undefined,
        execApprovalStatus: "pending",
      },
    ]);
  });

  it("tags approval-unavailable when details say so", () => {
    const cards = extractToolCards({
      role: "toolResult",
      toolName: "exec",
      content: [],
      details: {
        status: "approval-unavailable",
        reason: "no-approval-route",
        host: "gateway",
        command: "echo hi",
      },
    });
    expect(cards.find((c) => c.kind === "result")?.execApprovalStatus).toBe("unavailable");
  });
});
