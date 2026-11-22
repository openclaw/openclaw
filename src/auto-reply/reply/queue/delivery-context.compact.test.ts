import { describe, expect, it } from "vitest";
import { collectCurrentInboundContext } from "./delivery-context.js";
import type { FollowupRun } from "./types.js";

function item(context: NonNullable<FollowupRun["currentInboundContext"]>): FollowupRun {
  return { currentInboundContext: context } as unknown as FollowupRun;
}

describe("collectCurrentInboundContext compact fragments", () => {
  it("merges queued compact fragments and keeps instructions apart from data", () => {
    const merged = collectCurrentInboundContext([
      item({
        text: "Full one",
        compactText: "Short one\n\nDirective one",
        compactFragments: [
          { kind: "conversation-data", text: "Short one" },
          { kind: "runtime-instruction", text: "Directive one" },
        ],
      }),
      item({ text: "Full two", compactText: "Short two" }),
    ]);

    expect(merged?.compactFragments).toEqual([
      { kind: "runtime-instruction", text: "Queued #1 context:" },
      { kind: "conversation-data", text: "Short one" },
      { kind: "runtime-instruction", text: "Directive one" },
      { kind: "runtime-instruction", text: "Queued #2 context:" },
      { kind: "conversation-data", text: "Short two" },
    ]);
  });

  it("adds no compact fragments when no queued context has a compact projection", () => {
    const merged = collectCurrentInboundContext([item({ text: "One" }), item({ text: "Two" })]);

    expect(merged?.compactFragments).toBeUndefined();
  });
});
