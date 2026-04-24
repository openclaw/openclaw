import { describe, expect, it } from "vitest";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";

describe("buildChannelApprovalNativeTargetKey", () => {
  it("distinguishes targets whose parts contain colons", () => {
    const first = buildChannelApprovalNativeTargetKey({
      to: "!room:example.org",
      threadId: "$event:example.org",
    });
    const second = buildChannelApprovalNativeTargetKey({
      to: "!room",
      threadId: "example.org:$event:example.org",
    });

    expect(first).not.toBe(second);
  });

  it("normalizes surrounding whitespace", () => {
    expect(
      buildChannelApprovalNativeTargetKey({
        to: " room:one ",
        threadId: " 123 ",
      }),
    ).toBe(
      buildChannelApprovalNativeTargetKey({
        to: "room:one",
        threadId: "123",
      }),
    );
  });
});
