import { describe, expect, it } from "vitest";
import { isPromiseOnlyAckReplyPayload } from "./dispatch-from-config.js";

const promiseOnlyAckCases = [
  "I’m working through your request — I’ll post the result in 📋 System Config.",
  "I’m checking the attachment and the surrounding context — I’ll post the result in 📋 System Config.",
  "I’m investigating the failure path and checking the smallest safe fix — I’ll post the result in 📋 System Config.",
  "Still working — I’ll update here.",
  "Working on it — I’ll reply in this topic.",
  "I’ll update here.",
];

describe("isPromiseOnlyAckReplyPayload", () => {
  it.each(promiseOnlyAckCases)("detects promise-only acknowledgement finals: %s", (text) => {
    expect(isPromiseOnlyAckReplyPayload({ text })).toBe(true);
  });

  it("does not flag substantive final replies", () => {
    expect(
      isPromiseOnlyAckReplyPayload({
        text: "Done. I restarted the gateway, verified health is live, and the task DB shows 0 running tasks.",
      }),
    ).toBe(false);
  });

  it("does not flag long explanatory replies", () => {
    const text = `${"I’m investigating because the source branch has a stale topic-name cache. ".repeat(8)}I’ll post the result here.`;
    expect(isPromiseOnlyAckReplyPayload({ text })).toBe(false);
  });

  it("does not flag media replies", () => {
    expect(
      isPromiseOnlyAckReplyPayload({
        text: "I’m checking the attachment — I’ll post the result here.",
        mediaUrl: "file:///tmp/result.png",
      }),
    ).toBe(false);
  });
});
